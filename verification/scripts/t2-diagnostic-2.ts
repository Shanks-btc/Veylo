// Second approved diagnostic round: five dry quotes. No funds can move.
// Run: npx tsx scripts/t2-diagnostic-2.ts
import { readFileSync } from "node:fs";
import { record } from "../_util.js";

const QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";

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
const SOLANA = required("CONTRACTOR_SOLANA_ADDRESS");
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60 * 1000).toISOString();
const apiKey = { "X-API-Key": JWT };
const bearer = { Authorization: `Bearer ${JWT}` };

// Repeats reuse the recorded bodies, so only the fields named below can differ.
const recordedBody = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../results/${file}`, import.meta.url), "utf8")).request.body;
const docsExample = recordedBody("T2-diag2-docs-example.json");
const arbToSol = recordedBody("T2-diag4-usdc-arb-to-sol.json");

const nearToSol = (depositAndRefund: string) => ({
  dry: true,
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 100,
  originAsset: USDC_NEAR,
  depositType: depositAndRefund,
  destinationAsset: USDC_SOL,
  amount: "10000000",
  recipient: SOLANA,
  recipientType: "DESTINATION_CHAIN",
  refundTo: TREASURY,
  refundType: depositAndRefund,
  deadline: minutesFromNow(10),
});

const requests: [string, string, Record<string, string>, Record<string, unknown>][] = [
  ["T5", "dry-intents-quote", apiKey, nearToSol("INTENTS")],
  ["T2", "diag7-docs-example-bearer", bearer, { ...docsExample, deadline: minutesFromNow(3) }],
  ["T3a", "basic", apiKey, { ...arbToSol, confidentiality: "basic", deadline: minutesFromNow(10) }],
  ["T3a", "advanced", apiKey, { ...arbToSol, confidentiality: "advanced", deadline: minutesFromNow(10) }],
  ["T3b", "embedded", apiKey, nearToSol("CONFIDENTIAL_INTENTS")],
];

for (const [testId, name, auth, body] of requests) {
  if (body.dry !== true) throw new Error("Refusing a non-dry quote");
  const headers = { "Content-Type": "application/json", ...auth };
  const started = Date.now();
  const request = { method: "POST", url: QUOTE_URL, headers, body };
  let run: Record<string, unknown>;
  let status: number | string = "request failed";
  let parsed: { message?: string; correlationId?: string; quote?: unknown } | undefined;
  try {
    const res = await fetch(QUOTE_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let responseBody: unknown = text;
    try {
      responseBody = JSON.parse(text);
    } catch {
      // Non-JSON is kept verbatim as text.
    }
    status = res.status;
    parsed = responseBody as typeof parsed;
    run = { ranAt: new Date().toISOString(), latencyMs: Date.now() - started, request, response: { status: res.status, headers: Object.fromEntries(res.headers), body: responseBody } };
  } catch (err) {
    run = {
      ranAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      request,
      error: { message: err instanceof Error ? err.message : String(err), cause: err instanceof Error ? String(err.cause) : undefined },
    };
  }
  console.log(record(testId, name, run));
  console.log(`${testId}-${name} | HTTP ${status} | correlationId ${parsed?.correlationId}`);
  console.log(`  ${parsed?.message ?? JSON.stringify(parsed?.quote ?? run.error)}`);
}
