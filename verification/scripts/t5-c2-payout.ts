// T5 step C2: one live EXACT_OUTPUT 0.50 USDC payout to Base from the treasury's Intents balance.
// Stops on any error, with no retries. Refuses to sign unless the intent's debit is provably within the cap.
// Never prints or records the secret key. Run: npx tsx scripts/t5-c2-payout.ts
import { readFileSync } from "node:fs";
import { baseEncode, KeyPair, KeyPairSigner, keyToImplicitAddress } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { record } from "../_util.js";

const API = "https://1click.chaindefuser.com/v0";
const NEAR_RPC = "https://rpc.fastnear.com";
const BASE_RPC = "https://mainnet.base.org";
const USDC_NEAR_TOKEN = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const CAP = 1_000_000n; // 1.00 USDC, 6 decimals
const PAYOUT = "500000"; // 0.50 USDC, 6 decimals
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
const usdcBase = tokens.find((t) => t.symbol === "USDC" && t.blockchain === "base");
if (!usdcBase || usdcBase.decimals !== 6) stop("USDC on base is not as expected in T1");
const asset = usdcBase as Token;

async function nearView(params: Record<string, unknown>) {
  const body = { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", ...params } };
  const res = await fetch(NEAR_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return { request: { url: NEAR_RPC, body }, status: res.status, response: (await res.json()) as { result?: { result?: number[]; amount?: string }; error?: unknown } };
}
async function intentsBalance() {
  const args = Buffer.from(JSON.stringify({ account_id: TREASURY, token_id: USDC_NEAR_TOKEN })).toString("base64");
  const raw = await nearView({ request_type: "call_function", account_id: "intents.near", method_name: "mt_balance_of", args_base64: args });
  const bytes = raw.response.result?.result;
  return { at: new Date().toISOString(), raw, value: bytes ? (JSON.parse(Buffer.from(bytes).toString()) as string) : undefined };
}
async function treasuryAccount() {
  const raw = await nearView({ request_type: "view_account", account_id: TREASURY });
  return { at: new Date().toISOString(), raw, exists: Boolean(raw.response.result?.amount) };
}
async function baseUsdcBalance() {
  const data = "0x70a08231" + RECIPIENT.slice(2).toLowerCase().padStart(64, "0");
  const body = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: asset.contractAddress, data }, "latest"] };
  const res = await fetch(BASE_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const parsed = (await res.json()) as { result?: string };
  return { at: new Date().toISOString(), request: { url: BASE_RPC, body }, status: res.status, response: parsed, value: parsed.result ? BigInt(parsed.result).toString() : undefined };
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

// Balances first, so "before" is on record even if a later step stops the run.
const before = { intents: await intentsBalance(), account: await treasuryAccount(), baseUsdc: await baseUsdcBalance() };
record("T5", "c2-balances-before", before);
console.log(`Before: Intents USDC ${before.intents.value}; treasury account exists on-chain: ${before.account.exists}; Base USDC ${before.baseUsdc.value}`);
if (before.intents.value === undefined || before.baseUsdc.value === undefined) stop("could not read the starting balances");

// Live quote.
const quote = await api("/quote", {
  dry: false,
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 100,
  originAsset: USDC_NEAR_TOKEN,
  depositType: "INTENTS",
  destinationAsset: asset.assetId,
  amount: PAYOUT,
  recipient: RECIPIENT,
  recipientType: "DESTINATION_CHAIN",
  refundTo: TREASURY,
  refundType: "INTENTS",
  deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
});
record("T5", "c2-quote", quote);
const quoteBody = quote.response.body as { message?: string; correlationId?: string; quote?: Record<string, string> };
console.log(`Quote | HTTP ${quote.response.status} | correlationId ${quoteBody.correlationId} | ${quoteBody.message ?? JSON.stringify(quoteBody.quote)}`);
if (!quote.response.ok || !quoteBody.quote) stop("the live quote failed");
const q = quoteBody.quote;
if (BigInt(q.amountIn) > CAP) stop(`amountIn ${q.amountIn} is above the cap`);
if (BigInt(q.amountIn) > BigInt(before.intents.value as string)) stop("amountIn is above the Intents balance");
if (q.amountOut !== PAYOUT) stop(`amountOut ${q.amountOut} is not the requested ${PAYOUT}`);

// Generate.
const generated = await api("/generate-intent", { type: "swap_transfer", standard: "nep413", signerId: TREASURY, depositAddress: q.depositAddress });
record("T5", "c2-generate-intent", generated);
const genBody = generated.response.body as { message?: string; correlationId?: string; intent?: { standard: string; payload: Record<string, string> } };
console.log(`Generate | HTTP ${generated.response.status} | correlationId ${genBody.correlationId} | ${genBody.message ?? "intent returned"}`);
if (!generated.response.ok || !genBody.intent) stop("generate-intent failed");
const intent = genBody.intent;

// Checks on the unsigned payload. Nothing is signed unless all of them pass.
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
console.log(`Intent debits ${debit} USDC smallest units (cap ${CAP}); intent types: ${message.intents.map((i) => i.intent).join(", ")}`);
if (debit <= 0n) stop("could not find a USDC debit in the intent");
if (debit > CAP) stop(`the intent debit ${debit} is above the cap`);

// Sign the returned payload unmodified, then verify locally before anything is sent.
const payloadToSign = { message: intent.payload.message, nonce: new Uint8Array(nonce), recipient: intent.payload.recipient };
const signed = await new KeyPairSigner(keyPair).signNep413Message(TREASURY, payloadToSign);
const publicKey = signed.publicKey.toString();
const signature = "ed25519:" + baseEncode(signed.signature);
const offlineProvider = { viewAccessKey: async () => ({ permission: "FullAccess" }) } as unknown as Parameters<typeof verifyMessage>[0]["provider"];
await verifyMessage({ signerAccountId: TREASURY, signerPublicKey: publicKey, payload: payloadToSign, signature: signed.signature, provider: offlineProvider }).catch(() => stop("local signature verification failed"));

// Submit.
const submitted = await api("/submit-intent", { type: "swap_transfer", signedData: { ...intent, public_key: publicKey, signature } });
record("T5", "c2-submit-intent", submitted);
const submitBody = submitted.response.body as { message?: string; correlationId?: string; intentHash?: string };
const submittedAt = Date.now();
console.log(`Submit | HTTP ${submitted.response.status} | correlationId ${submitBody.correlationId} | intentHash ${submitBody.intentHash} | ${submitBody.message ?? "accepted"}`);
if (!submitted.response.ok || !submitBody.intentHash) stop("submit-intent failed");

// Poll until terminal, for at most 30 minutes.
const statusUrl = `${API}/status?depositAddress=${encodeURIComponent(q.depositAddress)}`;
const transitions: { at: string; secondsAfterSubmit: number; status: unknown; response: unknown }[] = [];
const pollErrors: { at: string; error: string }[] = [];
let last: unknown;
let polls = 0;
let terminal = false;
while (Date.now() < submittedAt + 30 * 60 * 1000) {
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
      transitions.push({ at, secondsAfterSubmit: (Date.parse(at) - submittedAt) / 1000, status, response: { httpStatus: res.status, body: parsed } });
      last = status;
      record("T5", "c2-status", { depositAddress: q.depositAddress, submittedAt: new Date(submittedAt).toISOString(), polls, intervalSeconds: 5, transitions, pollErrors });
      console.log(`${at} ${String(status)}`);
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
record("T5", "c2-status", { depositAddress: q.depositAddress, submittedAt: new Date(submittedAt).toISOString(), polls, intervalSeconds: 5, transitions, pollErrors, terminal, lastStatus: last });

// Balances right away, then again after 60 seconds in case an unused buffer is returned later.
const after = { intents: await intentsBalance(), account: await treasuryAccount(), baseUsdc: await baseUsdcBalance() };
await new Promise((resolve) => setTimeout(resolve, 60_000));
const settled = { intents: await intentsBalance(), account: await treasuryAccount(), baseUsdc: await baseUsdcBalance() };
record("T5", "c2-balances-after", { after, settled });
console.log(`Terminal: ${terminal}. Last status: ${String(last)}. Polls: ${polls}. Poll errors: ${pollErrors.length}.`);
console.log(`After: Intents USDC ${after.intents.value}; Base USDC ${after.baseUsdc.value}; treasury account exists: ${after.account.exists}`);
console.log(`After 60s: Intents USDC ${settled.intents.value}; Base USDC ${settled.baseUsdc.value}`);
