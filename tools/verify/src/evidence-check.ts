// Run by verify.mjs: re-checks every docs/EVIDENCE.md row against public RPC, with no keys.
// Prints one JSON line. A network problem is SKIPPED, never PASS.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkRow, DEFAULT_EVIDENCE_RPCS, parseEvidence, type EvidenceRpcs } from "./evidence.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const file = join(root, "docs", "EVIDENCE.md");
if (!existsSync(file)) {
  console.log(JSON.stringify({ error: "docs/EVIDENCE.md is missing: run pnpm evidence:generate" }));
  process.exit(0);
}
const env = (name: string, fallback: string) => process.env[name]?.trim() || fallback;
const rpcs: EvidenceRpcs = {
  near: env("EVIDENCE_NEAR_RPC_URL", DEFAULT_EVIDENCE_RPCS.near),
  base: env("EVIDENCE_BASE_RPC_URL", DEFAULT_EVIDENCE_RPCS.base),
  arb: env("EVIDENCE_ARBITRUM_RPC_URL", DEFAULT_EVIDENCE_RPCS.arb),
  bsc: env("EVIDENCE_BSC_RPC_URL", DEFAULT_EVIDENCE_RPCS.bsc),
  sol: env("EVIDENCE_SOLANA_RPC_URL", DEFAULT_EVIDENCE_RPCS.sol),
};
const rows = parseEvidence(readFileSync(file, "utf8"));
const results = [];
for (const row of rows) {
  const r = await checkRow(row, rpcs, globalThis.fetch);
  results.push({ chain: row.chain, tx: row.tx, event: row.event, ...r });
}
console.log(JSON.stringify({ results }));
