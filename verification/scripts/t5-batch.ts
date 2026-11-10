// T5 batch probe: two EXACT_OUTPUT 0.10 USDC payouts, Base and Arbitrum, submitted back to back.
// Both intents are generated, checked and signed before either is submitted. Stops on any error, with no retries.
// Never prints or records the secret key. Run: npx tsx scripts/t5-batch.ts
import { readFileSync } from "node:fs";
import { baseEncode, KeyPair, KeyPairSigner, keyToImplicitAddress } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { record } from "../_util.js";

const API = "https://1click.chaindefuser.com/v0";
const NEAR_RPC = "https://rpc.fastnear.com";
const USDC_NEAR_TOKEN = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const CAP = 300_000n; // 0.30 USDC total, 6 decimals
const PAYOUT = "100000"; // 0.10 USDC, 6 decimals
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) stop(`${name} is not set`);
  return value as string;
}
function stop(reason: string): never {
  console.log(`STOPPED: ${reason}`);
  process.exit(1);
}

const JWT = required("ONECLICK_JWT");
const TREASURY = required("TREASURY_ACCOUNT_ID");
const RECIPIENT = required("CONTRACTOR_EVM_ADDRESS");
const keyPair = KeyPair.fromString(required("TREASURY_SECRET_KEY") as KeyPairString);
if (keyToImplicitAddress(keyPair.getPublicKey()) !== TREASURY) stop("TREASURY_SECRET_KEY does not derive TREASURY_ACCOUNT_ID");

type Token = { assetId: string; blockchain: string; symbol: string; decimals: number; contractAddress: string };
const tokens: Token[] = JSON.parse(readFileSync(new URL("../results/T1-tokens.json", import.meta.url), "utf8")).response.body;
function usdcOn(chain: string): Token {
  const hit = tokens.find((t) => t.symbol === "USDC" && t.blockchain === chain);
  if (!hit || hit.decimals !== 6) stop(`USDC on ${chain} is not as expected in T1`);
  return hit as Token;
}
const ROUTES = [
  { name: "base", token: usdcOn("base"), rpc: "https://mainnet.base.org" },
  { name: "arb", token: usdcOn("arb"), rpc: "https://arb1.arbitrum.io/rpc" },
];

async function intentsBalance() {
  const args = Buffer.from(JSON.stringify({ account_id: TREASURY, token_id: USDC_NEAR_TOKEN })).toString("base64");
  const body = { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", request_type: "call_function", account_id: "intents.near", method_name: "mt_balance_of", args_base64: args } };
  const res = await fetch(NEAR_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const parsed = (await res.json()) as { result?: { result?: number[] } };
  const bytes = parsed.result?.result;
  return { at: new Date().toISOString(), request: { url: NEAR_RPC, body }, status: res.status, response: parsed, value: bytes ? (JSON.parse(Buffer.from(bytes).toString()) as string) : undefined };
}
async function recipientBalance(route: (typeof ROUTES)[number]) {
  const data = "0x70a08231" + RECIPIENT.slice(2).toLowerCase().padStart(64, "0");
  const body = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: route.token.contractAddress, data }, "latest"] };
  const res = await fetch(route.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const parsed = (await res.json()) as { result?: string };
  return { at: new Date().toISOString(), request: { url: route.rpc, body }, status: res.status, response: parsed, value: parsed.result ? BigInt(parsed.result).toString() : undefined };
}
async function snapshot() {
  return { intents: await intentsBalance(), base: await recipientBalance(ROUTES[0]), arb: await recipientBalance(ROUTES[1]) };
}
async function api(path: string, body: Record<string, unknown>) {
  const url = `${API}${path}`;
  const headers = { "Content-Type": "application/json", "X-API-Key": JWT };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON is kept verbatim as text.
  }
  return { ranAt: new Date().toISOString(), request: { method: "POST", url, headers, body }, response: { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers), body: parsed } };
}

type QuoteBody = { message?: string; correlationId?: string; quote?: Record<string, string> };
const quoteRequest = (route: (typeof ROUTES)[number], dry: boolean) => ({
  dry,
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 100,
  originAsset: USDC_NEAR_TOKEN,
  depositType: "INTENTS",
  destinationAsset: route.token.assetId,
  amount: PAYOUT,
  recipient: RECIPIENT,
  recipientType: "DESTINATION_CHAIN",
  refundTo: TREASURY,
  refundType: "INTENTS",
  deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
});

const before = await snapshot();
record("T5", "batch-balances-before", before);
console.log(`Before: Intents USDC ${before.intents.value}; Base USDC ${before.base.value}; Arbitrum USDC ${before.arb.value}`);
if (before.intents.value === undefined || before.base.value === undefined || before.arb.value === undefined) stop("could not read the starting balances");

// Dry quotes. The cap applies to the most that could leave: the sum of amountIn.
let dryTotal = 0n;
for (const route of ROUTES) {
  const dry = await api("/quote", quoteRequest(route, true));
  record("T5", `batch-dry-${route.name}`, dry);
  const body = dry.response.body as QuoteBody;
  console.log(`Dry ${route.name} | HTTP ${dry.response.status} | correlationId ${body.correlationId} | ${body.message ?? JSON.stringify(body.quote)}`);
  if (!dry.response.ok || !body.quote) stop(`the dry quote for ${route.name} failed`);
  dryTotal += BigInt(body.quote.amountIn);
}
if (dryTotal > CAP) stop(`dry amountIn total ${dryTotal} is above the cap`);

// Both live quotes first.
const live = [];
let liveTotal = 0n;
for (const route of ROUTES) {
  const quote = await api("/quote", quoteRequest(route, false));
  record("T5", `batch-quote-${route.name}`, quote);
  const body = quote.response.body as QuoteBody;
  console.log(`Live ${route.name} | HTTP ${quote.response.status} | correlationId ${body.correlationId} | ${body.message ?? JSON.stringify(body.quote)}`);
  if (!quote.response.ok || !body.quote) stop(`the live quote for ${route.name} failed`);
  if (body.quote.amountOut !== PAYOUT) stop(`amountOut ${body.quote.amountOut} is not the requested ${PAYOUT}`);
  liveTotal += BigInt(body.quote.amountIn);
  live.push({ route, q: body.quote });
}
if (liveTotal > CAP) stop(`live amountIn total ${liveTotal} is above the cap`);
if (liveTotal > BigInt(before.intents.value as string)) stop("live amountIn total is above the Intents balance");

// Generate, check and sign both before submitting either. Same checks and signing lines as C2.
const prepared = [];
let totalDebit = 0n;
for (const { route, q } of live) {
  const generated = await api("/generate-intent", { type: "swap_transfer", standard: "nep413", signerId: TREASURY, depositAddress: q.depositAddress });
  record("T5", `batch-generate-${route.name}`, generated);
  const genBody = generated.response.body as { message?: string; correlationId?: string; intent?: { standard: string; payload: Record<string, string> } };
  console.log(`Generate ${route.name} | HTTP ${generated.response.status} | correlationId ${genBody.correlationId} | ${genBody.message ?? "intent returned"}`);
  if (!generated.response.ok || !genBody.intent) stop(`generate-intent failed for ${route.name}`);
  const intent = genBody.intent;

  if (intent.standard !== "nep413") stop(`unexpected standard ${intent.standard}`);
  const payloadKeys = Object.keys(intent.payload).sort().join(",");
  if (payloadKeys !== "message,nonce,recipient") stop(`unexpected payload fields: ${payloadKeys}`);
  if (intent.payload.recipient !== "intents.near") stop(`unexpected recipient ${intent.payload.recipient}`);
  const nonce = Buffer.from(intent.payload.nonce, "base64");
  if (nonce.length !== 32 || nonce.toString("base64") !== intent.payload.nonce) stop("the nonce is not canonical base64 of 32 bytes");
  const message = JSON.parse(intent.payload.message) as { signer_id: string; intents: { intent: string; tokens?: Record<string, string>; diff?: Record<string, string> }[] };
  if (message.signer_id !== TREASURY) stop(`signer_id ${message.signer_id} is not the treasury`);

  let debit = 0n;
  for (const item of message.intents) {
    const entries = item.intent === "transfer" ? Object.entries(item.tokens ?? {}) : item.intent === "token_diff" ? Object.entries(item.diff ?? {}) : stop(`intent type ${item.intent} cannot be checked against the cap`);
    for (const [token, amount] of entries) {
      const spent = item.intent === "transfer" ? BigInt(amount) : -BigInt(amount);
      if (spent <= 0n) continue;
      if (token !== USDC_NEAR_TOKEN) stop(`the intent would spend another token: ${token}`);
      debit += spent;
    }
  }
  console.log(`Intent ${route.name} debits ${debit}; intent types: ${message.intents.map((i) => i.intent).join(", ")}`);
  if (debit <= 0n) stop("could not find a USDC debit in the intent");
  totalDebit += debit;
  if (totalDebit > CAP) stop(`the combined intent debit ${totalDebit} is above the cap`);

  const payloadToSign = { message: intent.payload.message, nonce: new Uint8Array(nonce), recipient: intent.payload.recipient };
  const signed = await new KeyPairSigner(keyPair).signNep413Message(TREASURY, payloadToSign);
  const publicKey = signed.publicKey.toString();
  const signature = "ed25519:" + baseEncode(signed.signature);
  const offlineProvider = { viewAccessKey: async () => ({ permission: "FullAccess" }) } as unknown as Parameters<typeof verifyMessage>[0]["provider"];
  await verifyMessage({ signerAccountId: TREASURY, signerPublicKey: publicKey, payload: payloadToSign, signature: signed.signature, provider: offlineProvider }).catch(() => stop("local signature verification failed"));

  prepared.push({ route, q, intent, publicKey, signature });
}
const [first, second] = prepared;
const facts = {
  distinctNonces: first.intent.payload.nonce !== second.intent.payload.nonce,
  distinctSignatures: first.signature !== second.signature,
  distinctDepositAddresses: first.q.depositAddress !== second.q.depositAddress,
  samePublicKey: first.publicKey === second.publicKey,
  totalDebit: totalDebit.toString(),
};
console.log(`Facts: ${JSON.stringify(facts)}`);

// Submit back to back, without waiting for the first to settle.
const tracked: { name: string; depositAddress: string; submittedAt: number }[] = [];
for (const item of prepared) {
  const submitted = await api("/submit-intent", { type: "swap_transfer", signedData: { ...item.intent, public_key: item.publicKey, signature: item.signature } });
  const submittedAt = Date.now();
  record("T5", `batch-submit-${item.route.name}`, submitted);
  const body = submitted.response.body as { message?: string; correlationId?: string; intentHash?: string };
  console.log(`Submit ${item.route.name} | ${new Date(submittedAt).toISOString()} | HTTP ${submitted.response.status} | correlationId ${body.correlationId} | intentHash ${body.intentHash} | ${body.message ?? "accepted"}`);
  if (!submitted.response.ok || !body.intentHash) {
    console.log(`Submit failed for ${item.route.name}. No further intents will be submitted.`);
    break;
  }
  tracked.push({ name: item.route.name, depositAddress: item.q.depositAddress, submittedAt });
}

// Poll each submitted intent independently, for at most 30 minutes.
async function poll(item: (typeof tracked)[number]) {
  const statusUrl = `${API}/status?depositAddress=${encodeURIComponent(item.depositAddress)}`;
  const transitions: { at: string; secondsAfterSubmit: number; status: unknown; response: unknown }[] = [];
  const pollErrors: { at: string; error: string }[] = [];
  let last: unknown;
  let polls = 0;
  let terminal = false;
  while (Date.now() < item.submittedAt + 30 * 60 * 1000) {
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
      if (status !== last || transitions.length === 0) {
        transitions.push({ at, secondsAfterSubmit: (Date.parse(at) - item.submittedAt) / 1000, status, response: { httpStatus: res.status, body: parsed } });
        last = status;
        console.log(`${at} ${item.name} ${String(status)}`);
      }
      if (typeof status === "string" && TERMINAL.has(status)) {
        terminal = true;
        break;
      }
    } catch (err) {
      pollErrors.push({ at, error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  record("T5", `batch-status-${item.name}`, { depositAddress: item.depositAddress, submittedAt: new Date(item.submittedAt).toISOString(), polls, intervalSeconds: 5, transitions, pollErrors, terminal, lastStatus: last });
  console.log(`${item.name}: terminal ${terminal}, last status ${String(last)}, polls ${polls}, poll errors ${pollErrors.length}`);
}
await Promise.all(tracked.map(poll));

// Balances right away, then again after 60 seconds in case an unused buffer is returned later.
const after = await snapshot();
await new Promise((resolve) => setTimeout(resolve, 60_000));
const settled = await snapshot();
record("T5", "batch-balances-after", { facts, after, settled });
console.log(`After: Intents USDC ${after.intents.value}; Base USDC ${after.base.value}; Arbitrum USDC ${after.arb.value}`);
console.log(`After 60s: Intents USDC ${settled.intents.value}; Base USDC ${settled.base.value}; Arbitrum USDC ${settled.arb.value}`);
