// T5 step C0: dry EXACT_OUTPUT 0.50 USDC quotes from the treasury's Intents balance. No funds can move.
// Run: npx tsx scripts/t5-c0-compare.ts
import { readFileSync } from "node:fs";
import { record } from "../_util.js";

const QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.log(`Stopped: ${name} is not set.`);
    process.exit(1);
  }
  return value;
}

const JWT = required("ONECLICK_JWT");
const TREASURY = required("TREASURY_ACCOUNT_ID");
const routes = [
  { name: "sol", recipient: required("CONTRACTOR_SOLANA_ADDRESS") },
  { name: "base", recipient: required("CONTRACTOR_EVM_ADDRESS") },
  { name: "arb", recipient: required("CONTRACTOR_EVM_ADDRESS") },
];

type Token = { assetId: string; blockchain: string; symbol: string; decimals: number };
const tokens: Token[] = JSON.parse(readFileSync(new URL("../results/T1-tokens.json", import.meta.url), "utf8")).response.body;

for (const route of routes) {
  const hits = tokens.filter((t) => t.symbol === "USDC" && t.blockchain === route.name);
  if (hits.length !== 1) throw new Error(`Expected one USDC on ${route.name}, got ${hits.length}`);
  const body = {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: USDC_NEAR,
    depositType: "INTENTS",
    destinationAsset: hits[0].assetId,
    amount: (5n * 10n ** BigInt(hits[0].decimals - 1)).toString(),
    recipient: route.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: TREASURY,
    refundType: "INTENTS",
    deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
  const headers = { "Content-Type": "application/json", "X-API-Key": JWT };
  const res = await fetch(QUOTE_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let parsed: { message?: string; correlationId?: string; quote?: unknown } | string = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON is kept verbatim as text.
  }
  record("T5", `c0-dry-${route.name}`, { ranAt: new Date().toISOString(), request: { method: "POST", url: QUOTE_URL, headers, body }, response: { status: res.status, headers: Object.fromEntries(res.headers), body: parsed } });
  const p = typeof parsed === "object" ? parsed : { message: parsed };
  console.log(`${route.name} | HTTP ${res.status} | amount ${body.amount} | correlationId ${p.correlationId}`);
  console.log(`  ${p.message ?? JSON.stringify(p.quote)}`);
}
