// Polls /v0/status for the funding quote every 15 seconds, then reads the Intents balance. Read-only.
// Gives up one hour after the requested deadline if the status is still not terminal.
// Run: npx tsx scripts/t5-fund-poll.ts
import { readFileSync } from "node:fs";
import { record } from "../_util.js";

const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);
const RPC = "https://rpc.fastnear.com";
const USDC_TOKEN_ID = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const live = JSON.parse(readFileSync(new URL("../results/T5-fund-live-quote.json", import.meta.url), "utf8"));
const depositAddress: string = live.response.body.quote.depositAddress;
const requestedDeadline = Date.parse(live.response.body.quoteRequest.deadline);
const treasury: string = live.response.body.quoteRequest.recipient;
const giveUpAt = requestedDeadline + 60 * 60 * 1000;
const statusUrl = `https://1click.chaindefuser.com/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`;

async function intentsBalance() {
  const body = {
    jsonrpc: "2.0",
    id: "veylo",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: "intents.near",
      method_name: "mt_balance_of",
      args_base64: Buffer.from(JSON.stringify({ account_id: treasury, token_id: USDC_TOKEN_ID })).toString("base64"),
    },
  };
  const at = new Date().toISOString();
  try {
    const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const parsed = (await res.json()) as { result?: { result?: number[] } };
    const bytes = parsed.result?.result;
    return { at, request: { url: RPC, body }, status: res.status, response: parsed, balance: bytes ? (JSON.parse(Buffer.from(bytes).toString()) as string) : undefined };
  } catch (err) {
    return { at, request: { url: RPC, body }, error: err instanceof Error ? err.message : String(err) };
  }
}

const balanceBefore = await intentsBalance();
const startedAt = new Date();
const transitions: { at: string; status: unknown; response: unknown }[] = [];
const pollErrors: { at: string; error: string }[] = [];
let lastStatus: unknown;
let polls = 0;
let terminal = false;

const save = (extra: Record<string, unknown> = {}) =>
  record("T5", "fund-status", { depositAddress, startedAt: startedAt.toISOString(), polls, intervalSeconds: 15, balanceBefore, transitions, pollErrors, ...extra });

while (Date.now() < giveUpAt) {
  polls++;
  const at = new Date().toISOString();
  try {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let parsed: { status?: unknown } | string = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON is kept verbatim as text.
    }
    const status = typeof parsed === "object" ? parsed.status : undefined;
    if (status !== lastStatus || transitions.length === 0) {
      transitions.push({ at, status, response: { httpStatus: res.status, body: parsed } });
      lastStatus = status;
      save();
      console.log(`${at} ${String(status)}`);
    }
    if (typeof status === "string" && TERMINAL.has(status)) {
      terminal = true;
      break;
    }
  } catch (err) {
    pollErrors.push({ at, error: err instanceof Error ? err.message : String(err) });
  }
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}

const balanceAfter = await intentsBalance();
console.log(save({ terminal, lastStatus, finishedAt: new Date().toISOString(), balanceAfter }));
console.log(`Terminal: ${terminal}. Last status: ${String(lastStatus)}. Polls: ${polls}. Poll errors: ${pollErrors.length}.`);
console.log(`Intents USDC before: ${balanceBefore.balance ?? "unavailable"}; after: ${balanceAfter.balance ?? "unavailable"}`);
