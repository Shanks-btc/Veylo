// `pnpm build`: bundles the API, both workers and the migration command into dist/bin, for
// `node dist/bin/...` in production (L24, L37). Never tsx in production.
//
// Why a bundler (esbuild) and not TypeScript project references: every workspace package exports
// its TypeScript source ("./src/index.ts") with NodeNext ".js" imports, so emitting them with tsc
// would mean changing every package's exports and build order. esbuild inlines only our own
// @veylo/* packages and leaves every npm dependency external, resolved from node_modules at
// runtime, so the output is our code alone. Type checking stays with tsc (pnpm typecheck).
import { builtinModules } from "node:module";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
const ENTRIES = {
  server: join(here, "src", "server.ts"),
  worker: join(here, "src", "worker.ts"),
  "worker-agents": join(here, "src", "worker-agents.ts"),
  migrate: join(here, "..", "..", "packages", "db", "src", "migrate-cli.ts"),
};

rmSync(out, { recursive: true, force: true });
const result = await build({
  entryPoints: ENTRIES,
  outdir: join(out, "bin"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  logLevel: "warning",
  metafile: true,
  plugins: [
    {
      name: "external-npm",
      setup(b) {
        // Bare imports outside the workspace stay external; @veylo/* and relative imports are bundled.
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.kind === "entry-point" || isAbsolute(args.path) || args.path.startsWith("@veylo/")
            ? undefined
            : { path: args.path, external: true },
        );
      },
    },
  ],
});
// Every npm package the bundle imports must be a runtime dependency of @veylo/api, or a production
// install (pnpm's strict node_modules) wouldn't have it next to dist/.
const declared = Object.keys(
  JSON.parse(readFileSync(join(here, "package.json"), "utf8")).dependencies,
);
const missing = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const i of output.imports) {
    if (!i.external || i.path.startsWith("node:") || builtinModules.includes(i.path)) continue;
    const name = i.path.startsWith("@")
      ? i.path.split("/").slice(0, 2).join("/")
      : i.path.split("/")[0];
    if (!declared.includes(name)) missing.add(name);
  }
}
if (missing.size > 0) {
  console.error(`build failed: not in @veylo/api dependencies: ${[...missing].join(", ")}`);
  process.exit(1);
}
// packages/db finds its migrations at ../migrations from the bundle, which is dist/migrations.
cpSync(join(here, "..", "..", "packages", "db", "migrations"), join(out, "migrations"), {
  recursive: true,
});
for (const name of Object.keys(ENTRIES)) {
  if (!existsSync(join(out, "bin", `${name}.js`))) {
    console.error(`build failed: dist/bin/${name}.js is missing`);
    process.exit(1);
  }
}
console.log(
  `built ${Object.keys(ENTRIES)
    .map((n) => `dist/bin/${n}.js`)
    .join(", ")}`,
);
