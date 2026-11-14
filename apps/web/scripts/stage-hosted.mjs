// Stages a hosted build for deployment (slice W7): the web app into <deploy>/web and the wallet
// bridge into <deploy>/wallet, each next to its Vercel project link (.vercel/project.json, which is
// kept). Deploy each with `vercel deploy --prod --cwd <deploy>/web` (and /wallet).
//
//   VEYLO_WEB_ORIGIN=https://... VEYLO_BRIDGE_ORIGIN=https://... VEYLO_API_ORIGIN=https://... \
//     node apps/web/scripts/stage-hosted.mjs
//
// The web project's vercel.json is the reviewed headers file (apps/web/vercel.json) plus exactly
// one rewrite: /api/* goes to the API project. Why: vercel.app is on the Public Suffix List, so the
// web app and the API are different *sites* to a browser, and the API's sign-in cookie would not be
// sent back. Forwarding /api on the web origin makes the cookie first-party; the API is still its own
// project with its own origin, and it still allows CORS only from the web origin.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const root = join(web, "..", "..");

function origin(name) {
  const value = process.env[name];
  try {
    const u = new URL(value ?? "");
    const local = /^(localhost|127\.|\[)/.test(u.hostname);
    if (u.origin === value && u.protocol === "https:" && !local) return value;
  } catch {
    // Reported below.
  }
  console.error(`stage: ${name} must be an https origin that isn't local, with no path`);
  process.exit(1);
}
const webOrigin = origin("VEYLO_WEB_ORIGIN");
const bridgeOrigin = origin("VEYLO_BRIDGE_ORIGIN");
const apiOrigin = origin("VEYLO_API_ORIGIN");
if (new Set([webOrigin, bridgeOrigin, apiOrigin]).size !== 3) {
  console.error(
    "stage: the web app, the wallet bridge and the API must be three different origins",
  );
  process.exit(1);
}

const deploy = process.env.VEYLO_DEPLOY_DIR ?? join(root, "deploy");
const webOut = process.env.VEYLO_WEB_DIR ?? join(web, "out");
const bridgeOut = process.env.VEYLO_BRIDGE_DIR ?? join(web, "out-bridge");
for (const dir of [webOut, bridgeOut]) {
  if (!existsSync(join(dir, "index.html")) && !existsSync(join(dir, "embedded", "index.html"))) {
    console.error(`stage: ${dir} holds no build. Build first.`);
    process.exit(1);
  }
}

/** Empties a staging folder but keeps .vercel (the project link). */
function clear(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name !== ".vercel") rmSync(join(dir, name), { recursive: true, force: true });
  }
}

const webDir = join(deploy, "web");
clear(webDir);
cpSync(webOut, webDir, { recursive: true });
const headers = JSON.parse(readFileSync(join(web, "vercel.json"), "utf8"));
if (headers.rewrites) {
  console.error(
    "stage: apps/web/vercel.json must not hold rewrites; this script adds the only one",
  );
  process.exit(1);
}
const staged = {
  ...headers,
  headers: [
    ...headers.headers,
    // The API's answers are per person and never stored by a cache.
    { source: "/api/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
  ],
  rewrites: [{ source: "/api/:path*", destination: `${apiOrigin}/:path*` }],
};
writeFileSync(join(webDir, "vercel.json"), JSON.stringify(staged, null, 2) + "\n");

const walletDir = join(deploy, "wallet");
clear(walletDir);
cpSync(bridgeOut, walletDir, { recursive: true });
if (!existsSync(join(walletDir, "vercel.json"))) {
  console.error("stage: the bridge build has no vercel.json");
  process.exit(1);
}

console.log(`staged ${webDir} (${webOrigin}, /api -> ${apiOrigin})`);
console.log(`staged ${walletDir} (${bridgeOrigin})`);
