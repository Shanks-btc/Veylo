// Builds the demo variant of the app (NEXT_PUBLIC_DEMO=1) into out-demo/, for the browser checks
// and for a hosted static demo that needs no API. The production build never contains it.
import { spawnSync } from "node:child_process";
import { renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_DEMO: "1",
  NEXT_PUBLIC_API_ORIGIN: "https://api.veylo.invalid",
  NEXT_PUBLIC_WALLET_BRIDGE_ORIGIN: "https://wallet.veylo.invalid",
  NEXT_PUBLIC_NEAR_RPC_URL: "https://rpc.fastnear.com",
  NEXT_PUBLIC_AUTH_RECIPIENT: "veylo.demo",
  NEXT_PUBLIC_PAYOUT_QUOTE_DEADLINE_MINUTES: "15",
  NEXT_PUBLIC_SITE_ORIGIN: "https://veylo.invalid",
};
const nextBin = join(
  dirname(createRequire(join(web, "package.json")).resolve("next/package.json")),
  "dist",
  "bin",
  "next",
);
const step = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: web, env, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
for (const s of ["gen-tokens.mjs", "fonts.mjs", "images.mjs"]) step([join(web, "scripts", s)]);
step([nextBin, "build", "--webpack"]);
step([join(web, "scripts", "csp.mjs")]);
rmSync(join(web, "out-demo"), { recursive: true, force: true });
renameSync(join(web, "out"), join(web, "out-demo"));
console.log("demo build: out-demo/");
