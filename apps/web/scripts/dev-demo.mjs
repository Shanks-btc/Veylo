// pnpm dev:web: the app on this computer with demo data: no API, no database, no wallet. The demo
// world runs in the browser (src/demo), shows a "Demo data" banner on every page, and the browser
// checks run for real on a recorded NEAR Intents quote.
import { spawn, spawnSync } from "node:child_process";
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
  // What the demo's payee list is signed for (src/demo/world.ts).
  NEXT_PUBLIC_AUTH_RECIPIENT: "veylo.demo",
  NEXT_PUBLIC_PAYOUT_QUOTE_DEADLINE_MINUTES: "15",
  NEXT_PUBLIC_SITE_ORIGIN: "https://veylo.invalid",
};
for (const s of ["gen-tokens.mjs", "fonts.mjs", "images.mjs"]) {
  const r = spawnSync(process.execPath, [join(web, "scripts", s)], {
    cwd: web,
    env,
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const nextBin = join(
  dirname(createRequire(join(web, "package.json")).resolve("next/package.json")),
  "dist",
  "bin",
  "next",
);
const next = spawn(process.execPath, [nextBin, "dev", "--webpack", "-p", "3000"], {
  cwd: web,
  env,
  stdio: "inherit",
});
console.log(
  "\ndev:web: open http://localhost:3000 (landing) and http://localhost:3000/app (demo app)",
);
next.on("exit", (code) => process.exit(code ?? 0));
