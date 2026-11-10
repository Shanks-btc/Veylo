// T1: token catalog. Public endpoint, no keys, no funds.
import { writeFileSync } from "node:fs";
import { record } from "../_util.js";

const URL_TOKENS = "https://1click.chaindefuser.com/v0/tokens";
const USDC_NEAR_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const WANTED = [
  ["USDC", "near"],
  ["USDC", "sol"],
  ["USDC", "base"],
  ["USDC", "arb"],
  ["USDT", "tron"],
  ["USDT", "near"],
] as const;

type Token = {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress: string | null;
};

const res = await fetch(URL_TOKENS);
const text = await res.text();
let body: unknown = text;
try {
  body = JSON.parse(text);
} catch {
  // Non-JSON is kept verbatim as text.
}

const jsonPath = record("T1", "tokens", {
  ranAt: new Date().toISOString(),
  request: { method: "GET", url: URL_TOKENS },
  response: { status: res.status, headers: Object.fromEntries(res.headers), body },
});

if (!res.ok || !Array.isArray(body)) {
  console.log(`T1 stopped: HTTP ${res.status}, array body: ${Array.isArray(body)}. Evidence: ${jsonPath}`);
  process.exit(1);
}

const tokens = body as Token[];
const rows = WANTED.flatMap(([symbol, chain]) => {
  const hits = tokens.filter((t) => t.symbol === symbol && t.blockchain === chain);
  return hits.length ? hits : [{ assetId: "NOT FOUND", blockchain: chain, symbol, decimals: NaN, contractAddress: null }];
});
const table = rows
  .map((t) => `| \`${t.assetId}\` | ${t.blockchain} | ${t.symbol} | ${t.decimals} | ${t.contractAddress === null ? "null" : `\`${t.contractAddress}\``} |`)
  .join("\n");

const usdcNear = tokens.find((t) => t.blockchain === "near" && t.contractAddress === USDC_NEAR_CONTRACT);
const foreign = WANTED.filter(([symbol, chain]) => chain !== "near" && tokens.some((t) => t.symbol === symbol && t.blockchain === chain));
const pass = Boolean(usdcNear) && foreign.length >= 3;
const expectedId = `nep141:${USDC_NEAR_CONTRACT}`;

writeFileSync(
  new URL("../results/T1-assets.md", import.meta.url),
  `# T1 assets\n\n| assetId | blockchain | symbol | decimals | contractAddress |\n|---|---|---|---|---|\n${table}\n`,
);
writeFileSync(
  new URL("../results/T1-tokens.md", import.meta.url),
  `# T1 token catalog\n\n` +
    `Result: **${pass ? "PASS" : "FAIL"}**\n\n` +
    `- GET ${URL_TOKENS} returned HTTP ${res.status} with ${tokens.length} tokens.\n` +
    `- USDC on NEAR with contract \`${USDC_NEAR_CONTRACT}\`: ${usdcNear ? `present, assetId \`${usdcNear.assetId}\`, symbol ${usdcNear.symbol}, decimals ${usdcNear.decimals}` : "NOT present"}.\n` +
    `- Expected assetId \`${expectedId}\` matches: ${usdcNear?.assetId === expectedId}.\n` +
    `- Payout assets found on other chains: ${foreign.length} of 4 (${foreign.map(([s, c]) => `${s} ${c}`).join(", ")}).\n` +
    `- Rows per wanted asset are in T1-assets.md. More than one row for a pair means the catalog lists several matches.\n` +
    `- Raw evidence: T1-tokens.json. No tx hashes: this test moves no funds.\n`,
);

console.log(`T1 ${pass ? "PASS" : "FAIL"}: ${tokens.length} tokens, usdcNear=${usdcNear?.assetId}, foreign=${foreign.length}`);
console.log(`| assetId | blockchain | symbol | decimals | contractAddress |\n${table}`);
console.log(jsonPath);
