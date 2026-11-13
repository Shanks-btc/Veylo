// Post-build: pins every page's inline scripts by hash and writes the CSP into each HTML file.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPolicy,
  assertOrigins,
  buildPolicy,
  deferHydration,
  inspectHtml,
} from "./csp-lib.mjs";

const out = fileURLToPath(new URL("../out", import.meta.url));
const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN;
const nearRpcUrl = process.env.NEXT_PUBLIC_NEAR_RPC_URL ?? "https://rpc.fastnear.com";
const archivalRpcUrl =
  process.env.NEXT_PUBLIC_NEAR_ARCHIVAL_RPC_URL ?? "https://archival-rpc.mainnet.fastnear.com";
const bridgeOrigin = process.env.NEXT_PUBLIC_WALLET_BRIDGE_ORIGIN;
if (!apiOrigin || !bridgeOrigin) {
  console.error("csp: NEXT_PUBLIC_API_ORIGIN and NEXT_PUBLIC_WALLET_BRIDGE_ORIGIN are required");
  process.exit(1);
}

assertOrigins([apiOrigin, bridgeOrigin, nearRpcUrl, archivalRpcUrl]);

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* htmlFiles(path);
    else if (name.endsWith(".html")) yield path;
  }
}

const report = [];
for (const file of htmlFiles(out)) {
  const name = relative(out, file);
  // The landing page hydrates after load (W6): its LCP is static text.
  const html =
    name === "index.html" ? deferHydration(readFileSync(file, "utf8")) : readFileSync(file, "utf8");
  const scriptHashes = inspectHtml(html, name);
  const policy = buildPolicy({ apiOrigin, nearRpcUrl, archivalRpcUrl, bridgeOrigin, scriptHashes });
  writeFileSync(file, applyPolicy(html, policy, name));
  report.push({ file: name, inlineScripts: scriptHashes.length });
}
if (report.length === 0) {
  console.error("csp: no HTML pages found in out/");
  process.exit(1);
}
writeFileSync(join(out, "csp-report.json"), JSON.stringify(report, null, 2));
console.log(`csp: ${report.length} page(s) pinned`);
