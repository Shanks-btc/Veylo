// `node apps/api/build-vercel.mjs`: builds the API as a Vercel Function in Build Output API form
// (W7), into deploy/api/.vercel/output. Deploy it with
//   vercel deploy --prebuilt --prod --cwd deploy/api
//
// Why prebuilt: Vercel then runs exactly the bundle that was built and tested here, not a second
// build in its own environment. Unlike build.mjs (which leaves npm packages external for a server
// that has node_modules), this bundles every dependency into one file, because a function has no
// install step. Nothing else about the app changes: the routes are the same `buildServer` routes.
import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { FUNCTION_MAX_DURATION_SECONDS } from "./src/function-limits.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const target = process.env.VERCEL_API_DEPLOY_DIR ?? join(root, "deploy", "api");
const output = join(target, ".vercel", "output");
const fn = join(output, "functions", "index.func");

// Only the build output is replaced: .vercel/project.json (the link) must survive.
rmSync(output, { recursive: true, force: true });
mkdirSync(join(fn, "bin"), { recursive: true });

await build({
  entryPoints: [join(here, "src", "vercel.ts")],
  outfile: join(fn, "bin", "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  minify: false,
  logLevel: "warning",
  // pg loads pg-native only inside a try/catch when asked for the native binding. We never ask.
  external: ["pg-native"],
  // Some bundled packages are CommonJS and call require(); give them one.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});

// packages/db finds its migrations at ../migrations from the bundle: index.func/migrations.
cpSync(join(root, "packages", "db", "migrations"), join(fn, "migrations"), { recursive: true });
writeFileSync(join(fn, "package.json"), JSON.stringify({ type: "module" }));
writeFileSync(
  join(fn, ".vc-config.json"),
  JSON.stringify(
    {
      runtime: "nodejs24.x",
      handler: "bin/index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      // Near the Neon database (aws-us-east-1). Cron sweeps and status refreshes stay well inside it.
      regions: ["iad1"],
      // Shared with apps/api/src/hosted.ts, which stops starting work well before this (a test checks).
      maxDuration: FUNCTION_MAX_DURATION_SECONDS,
    },
    null,
    2,
  ),
);

// Every request goes to the one function. The cron jobs call the internal routes with the secret
// Vercel sends as a bearer token; the routes check it (cron-routes.ts).
// Hobby plan: each job at most once a day (https://vercel.com/docs/cron-jobs/usage-and-pricing).
writeFileSync(
  join(output, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [{ src: "/(.*)", dest: "/index" }],
      crons: [
        { path: "/internal/cron/settlement", schedule: "0 4 * * *" },
        { path: "/internal/cron/prepare-drafts", schedule: "0 5 * * *" },
      ],
    },
    null,
    2,
  ),
);

const kb = Math.round(statSync(join(fn, "bin", "index.mjs")).size / 1024);
console.log(`built ${join(fn, "bin", "index.mjs")} (${kb} KB) and config.json with 2 cron jobs`);
