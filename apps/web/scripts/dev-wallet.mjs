// pnpm dev:wallet: a real-wallet test on this computer, with nothing deployed (slice W5, part B).
//   app     http://localhost:3000     the production build of the app, with its real strict CSP
//   bridge  http://127.0.0.1:3001     the wallet bridge, on a different origin, with its own CSP
//   API     http://localhost:4000     the real API, on your local database (not demo data)
// Both CSPs and both origin checks name exactly these two local origins. This is built in its own
// folders (out-local, out-bridge) and the build scripts refuse local origins unless this script
// asks for them, so a production build can never carry them. No payout is quoted or signed unless
// you do it yourself in the app.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const root = join(web, "..", "..");
const APP = "http://localhost:3000";
const BRIDGE = "http://127.0.0.1:3001";
const API = "http://localhost:4000";

if (!process.env.DATABASE_URL && !existsSync(join(root, ".env"))) {
  console.error(
    "dev:wallet needs your local database: set DATABASE_URL in the environment or in a .env file\n" +
      "at the repository root (see docs/DEPLOY.md section 13, and .env.example). Nothing was started.",
  );
  process.exit(1);
}

const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  VEYLO_LOCAL_WALLET_TEST: "1",
  NEXT_PUBLIC_API_ORIGIN: API,
  NEXT_PUBLIC_WALLET_BRIDGE_ORIGIN: BRIDGE,
  NEXT_PUBLIC_AUTH_RECIPIENT: "veylo.local",
  NEXT_PUBLIC_NEAR_RPC_URL: process.env.NEXT_PUBLIC_NEAR_RPC_URL ?? "https://rpc.fastnear.com",
  NEXT_PUBLIC_PAYOUT_QUOTE_DEADLINE_MINUTES: "15",
  // Metadata only; the local app is not served from here.
  NEXT_PUBLIC_SITE_ORIGIN: "https://veylo.invalid",
  BRIDGE_APP_ORIGIN: APP,
};
const node = process.execPath;
const run = (label, args, cwd = web) => {
  console.log(`dev:wallet: ${label}`);
  const r = spawnSync(node, args, { cwd, env, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`dev:wallet: "${label}" failed`);
    process.exit(r.status ?? 1);
  }
};
const nextBin = join(
  dirname(createRequire(join(web, "package.json")).resolve("next/package.json")),
  "dist",
  "bin",
  "next",
);

run("building the API", [join(root, "apps", "api", "build.mjs")], root);
for (const s of ["gen-tokens.mjs", "fonts.mjs", "images.mjs"]) run(s, [join(web, "scripts", s)]);
run("building the app", [nextBin, "build", "--webpack"]);
run("applying the app's strict CSP", [join(web, "scripts", "csp.mjs")]);
// The export lands in out/, which pnpm verify owns: move it aside, never leave local origins there.
rmSync(join(web, "out-local"), { recursive: true, force: true });
renameSync(join(web, "out"), join(web, "out-local"));
run("building the wallet bridge", [join(web, "scripts", "build-bridge.mjs")]);

const api = spawn(
  node,
  ["--env-file-if-exists=.env", join(root, "apps", "api", "dist", "bin", "server.js")],
  {
    cwd: root,
    env: {
      ...env,
      PORT: "4000",
      WEB_ORIGIN: APP,
      AUTH_RECIPIENT: "veylo.local",
      NODE_ENV: "development",
    },
    stdio: "inherit",
  },
);
api.on("exit", (code) => {
  console.error(
    `dev:wallet: the API stopped (exit ${code}). Is your database running and migrated?`,
  );
  process.exit(code ?? 1);
});
await serve(3000, { dir: join(web, "out-local"), host: "localhost" });
await serve(3001, {
  dir: join(web, "out-bridge"),
  headers: join(web, "out-bridge", "vercel.json"),
});
console.log(
  `\ndev:wallet is up. Open ${APP} and connect your Meteor wallet. Ctrl+C stops everything.`,
);
