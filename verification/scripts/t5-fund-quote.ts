// Fund the treasury's Intents balance from USDT on BSC. Quotes only; this script sends no funds.
// Dry quote first, then a live quote only if minAmountOut is at least 1.90 USDC.
// Run: npx tsx scripts/t5-fund-quote.ts
import { readFileSync } from "node:fs";
import { record } from "../_util.js";

const QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const FLOOR = 1_900_000n; // 1.90 USDC, 6 decimals

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
const REFUND = required("CONTRACTOR_EVM_ADDRESS");

type Token = { assetId: string; blockchain: string; symbol: string; decimals: number; contractAddress: string | null };
const tokens: Token[] = JSON.parse(readFileSync(new URL("../results/T1-tokens.json", import.meta.url), "utf8")).response.body;
const hits = tokens.filter((t) => t.symbol === "USDT" && t.blockchain === "bsc");
if (hits.length !== 1) {
  console.log(`Stopped: expected one USDT on bsc in T1-tokens.json, found ${hits.length}.`);
  process.exit(1);
}
const usdt = hits[0];
console.log(`USDT on BSC: ${JSON.stringify(usdt)}`);

const body = {
  dry: true,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: usdt.assetId,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: USDC_NEAR,
  amount: (2n * 10n ** BigInt(usdt.decimals)).toString(),
  recipient: TREASURY,
  recipientType: "INTENTS",
  refundTo: REFUND,
  refundType: "ORIGIN_CHAIN",
  deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
};

type QuoteBody = { message?: string; correlationId?: string; quote?: Record<string, unknown>; quoteRequest?: Record<string, unknown> };

async function post(requestBody: typeof body) {
  const headers = { "Content-Type": "application/json", "X-API-Key": JWT };
  const res = await fetch(QUOTE_URL, { method: "POST", headers, body: JSON.stringify(requestBody), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON is kept verbatim as text.
  }
  return { ranAt: new Date().toISOString(), request: { method: "POST", url: QUOTE_URL, headers, body: requestBody }, response: { status: res.status, headers: Object.fromEntries(res.headers), body: parsed } };
}

const dry = await post(body);
console.log(record("T5", "fund-dry-quote", dry));
const dryBody = dry.response.body as QuoteBody;
console.log(`Dry | HTTP ${dry.response.status} | correlationId ${dryBody.correlationId}`);
console.log(`  ${dryBody.message ?? JSON.stringify(dryBody.quote)}`);

const minOut = dryBody.quote?.minAmountOut;
if (typeof minOut !== "string") {
  console.log("Stopped: the dry quote has no minAmountOut.");
  process.exit(1);
}
if (BigInt(minOut) < FLOOR) {
  console.log(`Stopped: minAmountOut ${minOut} is below the 1.90 USDC floor.`);
  process.exit(1);
}

const live = await post({ ...body, dry: false });
console.log(record("T5", "fund-live-quote", live));
const liveBody = live.response.body as QuoteBody;
console.log(`Live | HTTP ${live.response.status} | correlationId ${liveBody.correlationId}`);
console.log(`  ${liveBody.message ?? JSON.stringify(liveBody.quote)}`);
if (liveBody.quoteRequest) console.log(`  Echoed request: ${JSON.stringify(liveBody.quoteRequest)}`);

const deadline = (liveBody.quote?.deadline as string | undefined) ?? body.deadline;
console.log(`Deadline, UTC: ${deadline}`);
console.log(`Deadline, Africa/Lagos: ${new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", dateStyle: "full", timeStyle: "long" }).format(new Date(deadline))}`);
