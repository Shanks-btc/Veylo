// Read-only re-read of the Base batch payout's status, to compare refundedAmount with the record saved at SUCCESS.
// Run: npx tsx scripts/t5-refund-recheck.ts
import { readFileSync } from "node:fs";
import { record } from "../_util.js";

const JWT = process.env.ONECLICK_JWT?.trim();
if (!JWT) {
  console.log("STOPPED: ONECLICK_JWT is not set");
  process.exit(1);
}
const results = new URL("../results/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, results), "utf8"));

const quote = load("T5-batch-quote-base").response.body.quote;
const saved = load("T5-batch-status-base").transitions.at(-1);
const url = `https://1click.chaindefuser.com/v0/status?depositAddress=${encodeURIComponent(quote.depositAddress)}`;
const headers = { "X-API-Key": JWT };
const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
const body = (await res.json()) as { status?: string; updatedAt?: string; swapDetails?: { refundedAmount?: string; amountIn?: string } };

const comparison = {
  signedAmountIn: quote.amountIn,
  minAmountIn: quote.minAmountIn,
  atFirstSuccess: { seenAt: saved.at, updatedAt: saved.response.body.updatedAt, refundedAmount: saved.response.body.swapDetails.refundedAmount },
  onReRead: { readAt: new Date().toISOString(), status: body.status, updatedAt: body.updatedAt, refundedAmount: body.swapDetails?.refundedAmount },
};
console.log(record("T5", "batch-refund-recheck", { comparison, request: { method: "GET", url, headers }, response: { status: res.status, headers: Object.fromEntries(res.headers), body } }));
console.log(JSON.stringify(comparison, null, 1));
