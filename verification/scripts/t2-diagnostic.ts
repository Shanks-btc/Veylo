// One approved T2 diagnostic round: catalog re-check plus four dry quotes. No funds can move.
// Run: npx tsx scripts/t2-diagnostic.ts
import { readFileSync } from "node:fs";
import { record } from "../_util.js";

const BASE = "https://1click.chaindefuser.com/v0";
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
const IMPLICIT = required("TREASURY_ACCOUNT_ID");
const EVM = required("CONTRACTOR_EVM_ADDRESS");
const SOLANA = required("CONTRACTOR_SOLANA_ADDRESS");
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60 * 1000).toISOString();

async function send(url: string, method: string, body?: Record<string, unknown>) {
  const headers: Record<string, string> = { "X-API-Key": JWT };
  if (body) headers["Content-Type"] = "application/json";
  const started = Date.now();
  const request = { method, url, headers, body };
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON is kept verbatim as text.
    }
    return { ranAt: new Date().toISOString(), latencyMs: Date.now() - started, request, response: { status: res.status, headers: Object.fromEntries(res.headers), body: parsed } };
  } catch (err) {
    return {
      ranAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      request,
      error: { message: err instanceof Error ? err.message : String(err), cause: err instanceof Error ? String(err.cause) : undefined },
    };
  }
}

// 1. Catalog re-check, saved separately so results/T1-tokens.json stays as the original evidence.
type Token = { assetId: string; blockchain: string; symbol: string; decimals: number; contractAddress: string | null };
const tokensRun = await send(`${BASE}/tokens`, "GET");
console.log(record("T2", "diag1-tokens", tokensRun));
const tokens = (tokensRun.response?.body ?? []) as Token[];
const original: Token[] = JSON.parse(readFileSync(new URL("../results/T1-tokens.json", import.meta.url), "utf8")).response.body;
const find = (list: Token[], assetId: string) => list.find((t) => t.assetId === assetId);
const usdcNearNow = find(tokens, USDC_NEAR);
const usdcArb = tokens.find((t) => t.symbol === "USDC" && t.blockchain === "arb");
const usdcSol = tokens.find((t) => t.symbol === "USDC" && t.blockchain === "sol");
console.log(`1 tokens | HTTP ${tokensRun.response?.status} | count now ${tokens.length}, originally ${original.length}`);
console.log(`  USDC near listed: ${Boolean(usdcNearNow)} ${JSON.stringify(usdcNearNow)}`);
console.log(`  Same entry as original apart from price: ${JSON.stringify({ ...usdcNearNow, price: 0, priceUpdatedAt: 0 }) === JSON.stringify({ ...find(original, USDC_NEAR), price: 0, priceUpdatedAt: 0 })}`);
console.log(`  USDC arb: ${usdcArb?.assetId} | USDC sol: ${usdcSol?.assetId}`);

// 2. The docs' Making a Request example, with dry:true and our recipient and refund account.
const docsExample = {
  dry: true,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: "nep141:wrap.near",
  depositType: "ORIGIN_CHAIN",
  destinationAsset: "nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near",
  amount: "100000000000000000000000",
  recipient: EVM,
  recipientType: "DESTINATION_CHAIN",
  refundTo: IMPLICIT,
  refundType: "ORIGIN_CHAIN",
};

const quotes: [string, Record<string, unknown>][] = [
  ["diag2-docs-example", { ...docsExample, deadline: minutesFromNow(3) }],
  // 3. As 2, changing only refundTo to an existing NEAR account.
  ["diag3-docs-example-existing-refund", { ...docsExample, refundTo: "wrap.near", deadline: minutesFromNow(3) }],
  // 4. A different origin asset and chain.
  ["diag4-usdc-arb-to-sol", {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: usdcArb?.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: usdcSol?.assetId,
    amount: "10000000",
    recipient: SOLANA,
    recipientType: "DESTINATION_CHAIN",
    refundTo: EVM,
    refundType: "ORIGIN_CHAIN",
    deadline: minutesFromNow(10),
  }],
  // 5. USDC near to USDC sol with 100 USDC.
  ["diag5-usdc-near-to-sol-100", {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: USDC_NEAR,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: usdcSol?.assetId,
    amount: "100000000",
    recipient: SOLANA,
    recipientType: "DESTINATION_CHAIN",
    refundTo: IMPLICIT,
    refundType: "ORIGIN_CHAIN",
    deadline: minutesFromNow(10),
  }],
];

for (const [name, body] of quotes) {
  const run = await send(`${BASE}/quote`, "POST", body);
  console.log(record("T2", name, run));
  const parsed = run.response?.body as { message?: string; correlationId?: string; quote?: unknown } | undefined;
  console.log(`${name} | HTTP ${run.response?.status ?? "request failed"} | correlationId ${parsed?.correlationId}`);
  console.log(`  top-level keys: ${parsed && typeof parsed === "object" ? Object.keys(parsed).join(", ") : "n/a"}`);
  console.log(`  ${parsed?.message ?? JSON.stringify(parsed?.quote ?? run.error)}`);
}
