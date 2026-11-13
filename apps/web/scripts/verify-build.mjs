// For `pnpm verify`: builds the static web app with placeholder public settings, applies the CSP,
// then re-reads every page to prove each has the policy and every inline script is pinned.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgePolicy, embeddedPolicy } from "./bridge-csp.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_API_ORIGIN: "https://api.veylo.invalid",
  NEXT_PUBLIC_NEAR_RPC_URL: "https://rpc.fastnear.com",
  NEXT_PUBLIC_AUTH_RECIPIENT: "veylo.invalid",
  NEXT_PUBLIC_PAYOUT_QUOTE_DEADLINE_MINUTES: "15",
  NEXT_PUBLIC_SITE_ORIGIN: "https://veylo.invalid",
  NEXT_PUBLIC_WALLET_BRIDGE_ORIGIN: "https://wallet.veylo.invalid",
  BRIDGE_APP_ORIGIN: "https://app.veylo.invalid",
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
step([join(web, "scripts", "gen-tokens.mjs")]);
step([join(web, "scripts", "fonts.mjs")]);
step([join(web, "scripts", "images.mjs")]);
step([nextBin, "build", "--webpack"]);
step([join(web, "scripts", "csp.mjs")]);
step([join(web, "scripts", "build-bridge.mjs")]);

const out = join(web, "out");
let pages = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".html")) check(path);
  }
};
function check(path) {
  const html = readFileSync(path, "utf8");
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  if (!meta) throw new Error(`${path}: no CSP`);
  const policy = meta[1].replaceAll("&quot;", '"');
  if (/unsafe-inline|unsafe-eval/.test(policy)) throw new Error(`${path}: unsafe policy`);
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc=/.test(m[1]) || /type="application\/(json|ld\+json)"/.test(m[1])) continue;
    const hash = `'sha256-${createHash("sha256").update(m[2]).digest("base64")}'`;
    if (!policy.includes(hash)) throw new Error(`${path}: inline script not pinned`);
  }
  pages += 1;
}
walk(out);
// No local origin may appear anywhere in a production build or its bridge.
const LOCAL = /(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/;
// Only what carries our configuration: pages, header files, our own page chunks and the bridge
// script. Vendored code (the pinned wallet executor, framework polyfills) may mention localhost.
const CARRIES_CONFIG = /(\.html$|vercel\.json$|[\\/]chunks[\\/]app[\\/].*\.js$|[\\/]main\.js$)/;
function scan(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "wallets") scan(path);
    } else if (CARRIES_CONFIG.test(path) && LOCAL.test(readFileSync(path, "utf8")))
      throw new Error(`${path}: names a local origin`);
  }
}
scan(out);
scan(join(web, "out-bridge"));

// The demo world (src/demo) must never reach a production build: it carries a marker string, a
// throwaway signing key and a recorded quote, and its stand-in wallet signs without asking.
function noDemo(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) noDemo(path);
    else if (/\.(js|html)$/.test(name) && readFileSync(path, "utf8").includes("veylo-demo-world"))
      throw new Error(`${path}: the demo world is in a production build`);
  }
}
noDemo(out);
if (pages === 0) throw new Error("no pages built");

// ---- Slice W6: every page, every wallet's bridge page, every pinned executor ----
const hasPage = (base, route) =>
  existsSync(join(base, route === "" ? "index.html" : `${route}.html`)) ||
  existsSync(join(base, route, "index.html"));
const REQUIRED_PAGES = [
  "",
  "docs",
  "security",
  "privacy",
  "terms",
  "verify",
  "proof",
  "app/sign-in",
  "app/sign-up",
  "app/verify-email",
  "app/forgot-password",
  "app/reset-password",
  "app/setup",
  "app",
  "app/fund",
  "app/contractors",
  "app/contractor",
  "app/contractor/add-address",
  "app/contractors/import",
  "app/payees",
  "app/pay-runs",
  "app/pay-run",
  "app/pay-run/status",
  "app/schedules",
  "app/ledger",
  "app/statements",
  "app/audit",
  "app/team",
  "app/settings",
  "app/privacy-proof",
  "portal/accept",
  "portal",
  "portal/address",
  "portal/balance",
];
for (const route of REQUIRED_PAGES)
  if (!hasPage(out, route)) throw new Error(`the build has no page for /${route}`);

const lock = JSON.parse(readFileSync(join(web, "src", "wallet", "wallets.lock.json"), "utf8"));
const bridgeOut = join(web, "out-bridge");
const policyOf = (file) => {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(
    readFileSync(file, "utf8"),
  );
  if (!m) throw new Error(`${file}: no CSP`);
  return m[1].replaceAll("&quot;", '"');
};
let wallets = 0;
for (const w of lock.wallets.filter((x) => x.enabled)) {
  const page = join(bridgeOut, "w", w.id, "index.html");
  if (!existsSync(page)) throw new Error(`no bridge page for the enabled wallet ${w.id}`);
  const expected = bridgePolicy({
    appOrigin: env.BRIDGE_APP_ORIGIN,
    nearRpcUrl: env.NEXT_PUBLIC_NEAR_RPC_URL,
    apiOrigin: env.NEXT_PUBLIC_API_ORIGIN,
    wallet: w,
  }).meta;
  const policy = policyOf(page);
  if (policy !== expected)
    throw new Error(`${w.id}: the bridge page's CSP is not the reviewed one`);
  // A wallet's sandboxed executor inherits this page's policy, so inline script is allowed here (never
  // in the app). Dynamic code evaluation is not.
  if (/unsafe-eval/.test(policy)) throw new Error(`${w.id}: the bridge policy allows eval`);
  const executor = join(bridgeOut, "wallets", w.executor.file);
  if (!existsSync(executor))
    throw new Error(`${w.id}: the pinned executor ${w.executor.file} is not served`);
  const hash = createHash("sha256").update(readFileSync(executor)).digest("hex");
  if (hash !== w.executor.sha256)
    throw new Error(`${w.id}: the served executor's hash is not its pin`);
  wallets += 1;
}
// No catch-all header rule: it would also match /w/ and /embedded/ and could replace the Veylo wallet
// page's passkey permission, depending on how a host orders duplicate headers.
const bridgeRules = JSON.parse(readFileSync(join(bridgeOut, "vercel.json"), "utf8")).headers;
if (bridgeRules.some((r) => r.source === "/(.*)")) throw new Error("the bridge's headers have a catch-all rule");
const passkeyRules = bridgeRules.filter((r) => r.headers.some((h) => h.key === "Permissions-Policy" && h.value.includes("publickey-credentials")));
if (passkeyRules.length !== 1 || passkeyRules[0].source !== "/embedded/(.*)") throw new Error("only the Veylo wallet page may be allowed passkeys");
// The Veylo wallet page: no network of any kind.
const embedded = policyOf(join(bridgeOut, "embedded", "index.html"));
if (embedded !== embeddedPolicy({ appOrigin: env.BRIDGE_APP_ORIGIN }).meta)
  throw new Error("the embedded wallet page's CSP is not the reviewed one");
if (!embedded.includes("connect-src 'none'"))
  throw new Error("the embedded wallet page may reach the network");
// The app's own policy never names a wallet's host: wallets are the bridge's business, not the app's.
const appPolicy = policyOf(join(out, "index.html"));
for (const w of lock.wallets.filter((x) => x.enabled))
  for (const host of w.allow?.connect ?? [])
    if (appPolicy.includes(host)) throw new Error(`the app's CSP names ${host}, a host of ${w.id}`);

console.log(
  `web build: ${pages} page(s), every inline script pinned; ${REQUIRED_PAGES.length} required pages; ${wallets} wallet bridge page(s) with their reviewed policy and pinned executor`,
);
