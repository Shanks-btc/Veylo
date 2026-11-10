// T5d: contractor cash-out. EXACT_OUTPUT 0.03 USDC from the recipient's confidential balance to Base, then a privacy check.
// Stops on any error, with no retries. Never prints or records a secret key; session tokens are registered for redaction.
// Run: npx tsx scripts/t5d.ts
import { readFileSync } from "node:fs";
import { baseEncode, KeyPair, KeyPairSigner, keyToImplicitAddress } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { record, registerSecret } from "../_util.js";

const API = "https://1click.chaindefuser.com/v0";
const NEAR_RPC = "https://rpc.fastnear.com";
const BASE_RPC = "https://mainnet.base.org";
const USDC_NEAR_TOKEN = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const AMOUNT = "30000"; // 0.03 USDC
const CAP = 50_000n; // 0.05 USDC may leave the recipient's confidential balance
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);

function stop(reason: string): never {
  console.log(`STOPPED: ${reason}`);
  process.exit(1);
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) stop(`${name} is not set`);
  return value as string;
}

const JWT = required("ONECLICK_JWT");
const TREASURY = required("TREASURY_ACCOUNT_ID");
const RECIPIENT = required("RECIPIENT_NEAR_ACCOUNT_ID");
const BASE_ADDRESS = required("CONTRACTOR_EVM_ADDRESS");
const recipientKey = KeyPair.fromString(required("RECIPIENT_NEAR_SECRET_KEY") as KeyPairString);
if (keyToImplicitAddress(recipientKey.getPublicKey()) !== RECIPIENT) stop("RECIPIENT_NEAR_SECRET_KEY does not derive RECIPIENT_NEAR_ACCOUNT_ID");
const partner = { "Content-Type": "application/json", "X-API-Key": JWT };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mentions = (value: unknown, needle: string) => JSON.stringify(value ?? null).toLowerCase().includes(needle.toLowerCase());

const results = new URL("../results/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, results), "utf8"));
type Token = { assetId: string; blockchain: string; symbol: string; decimals: number; contractAddress: string };
const usdcBase = (load("T1-tokens").response.body as Token[]).find((t) => t.symbol === "USDC" && t.blockchain === "base") ?? stop("USDC on base is missing from T1");
const t5cDeposit: string = load("T5c-quote").response.body.quote.depositAddress;
const t5cIntentHash: string = load("T5c-submit").response.body.intentHash;

async function send(method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON is kept verbatim as text.
  }
  return { ranAt: new Date().toISOString(), request: { method, url, headers, body }, response: { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers), body: parsed } };
}
function requireOk(step: string, run: { response: { ok: boolean; status: number; body: unknown } }) {
  const body = run.response.body as { correlationId?: string } | string;
  console.log(`${step} | HTTP ${run.response.status} | correlationId ${typeof body === "object" ? body?.correlationId : undefined}`);
  if (!run.response.ok) stop(`${step} failed: ${JSON.stringify(run.response.body)}`);
}
async function nearView(method: string, args: unknown) {
  const body = { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", request_type: "call_function", account_id: "intents.near", method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } };
  const res = await fetch(NEAR_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const parsed = (await res.json()) as { result?: { result?: number[] } };
  const bytes = parsed.result?.result;
  return { at: new Date().toISOString(), status: res.status, response: parsed, value: bytes ? (JSON.parse(Buffer.from(bytes).toString()) as unknown) : undefined };
}
async function evm(method: string, params: unknown[]) {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  const res = await fetch(BASE_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  return { request: { url: BASE_RPC, body }, status: res.status, response: (await res.json()) as { result?: Record<string, unknown> & { from?: string; to?: string; input?: string; logs?: { topics: string[]; data: string; address: string }[] } | string; error?: unknown } };
}
async function baseUsdc() {
  const data = "0x70a08231" + BASE_ADDRESS.slice(2).toLowerCase().padStart(64, "0");
  const run = await evm("eth_call", [{ to: usdcBase.contractAddress, data }, "latest"]);
  return typeof run.response.result === "string" ? BigInt(run.response.result).toString() : undefined;
}
async function session(label: string) {
  const modulePath = new URL("../node_modules/@defuse-protocol/intents-sdk/dist/src/intents/expirable-nonce.js", import.meta.url).href;
  const { VersionedNonceBuilder } = (await import(modulePath)) as { VersionedNonceBuilder: { createTimestampedNonceBytes(start: Date): Uint8Array; encodeNonce(salt: Uint8Array, deadline: Date, randomBytes: Uint8Array): string } };
  const saltRead = await nearView("current_salt", {});
  if (typeof saltRead.value !== "string") stop("could not read current_salt from intents.near");
  const deadline = new Date(Date.now() + 5 * 60_000);
  const encodedNonce = VersionedNonceBuilder.encodeNonce(new Uint8Array(Buffer.from(saltRead.value, "hex")), deadline, VersionedNonceBuilder.createTimestampedNonceBytes(new Date()));
  const payload = { recipient: "intents.near", nonce: encodedNonce, message: JSON.stringify({ deadline: deadline.toISOString(), intents: [], signer_id: RECIPIENT }) };
  const signed = await new KeyPairSigner(recipientKey).signNep413Message(RECIPIENT, { message: payload.message, nonce: new Uint8Array(Buffer.from(encodedNonce, "base64")), recipient: payload.recipient });
  const signedData = { standard: "nep413", payload, public_key: signed.publicKey.toString(), signature: "ed25519:" + baseEncode(signed.signature) };
  const auth = await send("POST", `${API}/auth/authenticate`, { "Content-Type": "application/json" }, { signedData });
  const body = auth.response.body as { accessToken?: string; refreshToken?: string };
  registerSecret(body?.accessToken);
  registerSecret(body?.refreshToken);
  record("T5d", `${label}-authenticate`, auth);
  requireOk(`${label} authenticate`, auth);
  const balances = await send("GET", `${API}/account/balances`, { Authorization: `Bearer ${body.accessToken}` });
  record("T5d", `${label}-balances`, balances);
  requireOk(`${label} balances`, balances);
  console.log(`  ${JSON.stringify(balances.response.body)}`);
  return balances.response.body;
}

const before = { confidential: await session("before"), publicUsdc: (await nearView("mt_balance_of", { account_id: RECIPIENT, token_id: USDC_NEAR_TOKEN })).value, baseUsdc: await baseUsdc() };
record("T5d", "balances-before", before);
console.log(`Before: public ${JSON.stringify(before.publicUsdc)}; Base USDC ${before.baseUsdc}`);
if (before.baseUsdc === undefined) stop("could not read the Base balance");

const quoteBody = {
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 100,
  originAsset: USDC_NEAR_TOKEN,
  depositType: "CONFIDENTIAL_INTENTS",
  destinationAsset: usdcBase.assetId,
  amount: AMOUNT,
  recipient: BASE_ADDRESS,
  recipientType: "DESTINATION_CHAIN",
  refundTo: RECIPIENT,
  refundType: "CONFIDENTIAL_INTENTS",
  deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
};
const dry = await send("POST", `${API}/quote`, partner, { dry: true, ...quoteBody });
record("T5d", "dry", dry);
requireOk("dry quote", dry);
const dryQuote = (dry.response.body as { quote: Record<string, string> }).quote;
console.log(`  ${JSON.stringify(dryQuote)}`);
if (BigInt(dryQuote.amountIn) > CAP) stop(`dry amountIn ${dryQuote.amountIn} is above the cap`);

const live = await send("POST", `${API}/quote`, partner, { dry: false, ...quoteBody });
record("T5d", "quote", live);
requireOk("live quote", live);
const q = (live.response.body as { quote: Record<string, string> }).quote;
console.log(`  ${JSON.stringify(q)}`);
if (BigInt(q.amountIn) > CAP) stop(`amountIn ${q.amountIn} is above the cap`);
if (q.amountOut !== AMOUNT) stop(`amountOut ${q.amountOut} is not the requested ${AMOUNT}`);

const generated = await send("POST", `${API}/generate-intent`, partner, { type: "swap_transfer", standard: "nep413", signerId: RECIPIENT, depositAddress: q.depositAddress });
record("T5d", "generate", generated);
requireOk("generate", generated);
const intent = (generated.response.body as { intent: { standard: string; payload: Record<string, string> } }).intent;
console.log(`  Verifier in payload: ${intent.payload.recipient}`);
console.log(`  Message: ${intent.payload.message}`);

if (intent.standard !== "nep413") stop(`unexpected standard ${intent.standard}`);
const payloadKeys = Object.keys(intent.payload).sort().join(",");
if (payloadKeys !== "message,nonce,recipient") stop(`unexpected payload fields: ${payloadKeys}`);
if (intent.payload.recipient !== "intents.far") stop(`unexpected verifier for a confidential debit: ${intent.payload.recipient}`);
const nonce = Buffer.from(intent.payload.nonce, "base64");
if (nonce.length !== 32 || nonce.toString("base64") !== intent.payload.nonce) stop("the nonce is not canonical base64 of 32 bytes");
const message = JSON.parse(intent.payload.message) as { signer_id: string; intents: { intent: string; tokens?: Record<string, string> }[] };
if (message.signer_id !== RECIPIENT) stop(`signer_id ${message.signer_id} is not the recipient`);
let debit = 0n;
for (const item of message.intents) {
  if (item.intent !== "transfer") stop(`intent type ${item.intent} cannot be checked against the cap`);
  for (const [token, amount] of Object.entries(item.tokens ?? {})) {
    if (!(token.startsWith("imt:") && token.endsWith(`:${USDC_NEAR_TOKEN}`))) stop(`the intent would not spend confidential USDC: ${token}`);
    debit += BigInt(amount);
  }
}
console.log(`  Intent debits ${debit}; cap ${CAP}`);
if (debit <= 0n) stop("could not find a USDC debit in the intent");
if (debit > CAP) stop(`the intent debit ${debit} is above the cap`);

// Same signing lines as C2, with the recipient's key.
const payloadToSign = { message: intent.payload.message, nonce: new Uint8Array(nonce), recipient: intent.payload.recipient };
const signed = await new KeyPairSigner(recipientKey).signNep413Message(RECIPIENT, payloadToSign);
const publicKey = signed.publicKey.toString();
const signature = "ed25519:" + baseEncode(signed.signature);
const offlineProvider = { viewAccessKey: async () => ({ permission: "FullAccess" }) } as unknown as Parameters<typeof verifyMessage>[0]["provider"];
await verifyMessage({ signerAccountId: RECIPIENT, signerPublicKey: publicKey, payload: payloadToSign, signature: signed.signature, provider: offlineProvider }).catch(() => stop("local signature verification failed"));

const submitted = await send("POST", `${API}/submit-intent`, partner, { type: "swap_transfer", signedData: { ...intent, public_key: publicKey, signature } });
const submittedAt = Date.now();
record("T5d", "submit", submitted);
requireOk("submit", submitted);
console.log(`  intentHash ${(submitted.response.body as { intentHash?: string }).intentHash}`);

const statusUrl = `${API}/status?depositAddress=${encodeURIComponent(q.depositAddress)}`;
const transitions: { at: string; secondsAfterSubmit: number; status: unknown; response: unknown }[] = [];
const pollErrors: { at: string; error: string }[] = [];
let last: unknown;
let lastBody: { status?: unknown; updatedAt?: string; swapDetails?: { nearTxHashes?: string[]; destinationChainTxHashes?: { hash: string }[] } } | undefined;
let polls = 0;
let terminal = false;
while (Date.now() < submittedAt + 30 * 60 * 1000) {
  polls++;
  const at = new Date().toISOString();
  try {
    const run = await send("GET", statusUrl, partner);
    const body = run.response.body as NonNullable<typeof lastBody>;
    lastBody = body;
    if (body?.status !== last || transitions.length === 0) {
      transitions.push({ at, secondsAfterSubmit: (Date.parse(at) - submittedAt) / 1000, status: body?.status, response: { httpStatus: run.response.status, body } });
      last = body?.status;
      console.log(`  ${at} +${(Date.parse(at) - submittedAt) / 1000}s ${String(last)}`);
    }
    if (typeof body?.status === "string" && TERMINAL.has(body.status)) {
      terminal = true;
      break;
    }
  } catch (err) {
    pollErrors.push({ at, error: err instanceof Error ? err.message : String(err) });
  }
  await sleep(5_000);
}
record("T5d", "status", { depositAddress: q.depositAddress, submittedAt: new Date(submittedAt).toISOString(), polls, intervalSeconds: 5, transitions, pollErrors, terminal, lastStatus: last });
console.log(`Terminal ${terminal}; last status ${String(last)}; polls ${polls}; poll errors ${pollErrors.length}`);
console.log(`Details: ${JSON.stringify(lastBody?.swapDetails)}`);

await sleep(30_000);
const after = { confidential: await session("after"), publicUsdc: (await nearView("mt_balance_of", { account_id: RECIPIENT, token_id: USDC_NEAR_TOKEN })).value, baseUsdc: await baseUsdc() };
record("T5d", "balances-after", after);
console.log(`After: public ${JSON.stringify(after.publicUsdc)}; Base USDC ${after.baseUsdc}`);

// Privacy check. None of these requests carry credentials.
const visibleText = (html: unknown) => (typeof html === "string" ? html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
const scan = (value: unknown) => ({
  treasury: mentions(value, TREASURY),
  recipientNear: mentions(value, RECIPIENT),
  baseAddress: mentions(value, BASE_ADDRESS),
  depositAddress: mentions(value, q.depositAddress),
  t5cDepositAddress: mentions(value, t5cDeposit),
  t5cIntentHash: mentions(value, t5cIntentHash),
});

const anonStatus = await send("GET", statusUrl, {});
const page = await send("GET", `https://explorer.near-intents.org/transactions/${q.depositAddress}`, {});
const details = lastBody?.swapDetails;
const baseHash = details?.destinationChainTxHashes?.find((h) => h.hash.startsWith("0x"))?.hash;
const tx = baseHash ? await evm("eth_getTransactionByHash", [baseHash]) : undefined;
const receipt = baseHash ? await evm("eth_getTransactionReceipt", [baseHash]) : undefined;
const txResult = tx?.response.result as { from?: string; to?: string; input?: string } | undefined;
const logs = ((receipt?.response.result as { logs?: { topics: string[]; data: string; address: string }[] } | undefined)?.logs ?? []);
const transfers = logs.filter((l) => l.topics[0]?.startsWith("0xddf252ad")).map((l) => ({ token: l.address, from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), amount: BigInt(l.data).toString() }));

const nearTxs = [];
for (const hash of details?.nearTxHashes ?? []) {
  const body = { jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: "intents.near", wait_until: "NONE" } };
  const res = await fetch(NEAR_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  const parsed = (await res.json()) as { result?: { receipts_outcome?: { outcome: { logs: string[] } }[] }; error?: unknown };
  const nearLogs = (parsed.result?.receipts_outcome ?? []).flatMap((o) => o.outcome.logs);
  nearTxs.push({ hash, error: parsed.error, scan: scan(parsed.result), logs: nearLogs, raw: parsed });
  await sleep(1_500);
}

// Address reuse: does a public source already tie this Base address to the treasury?
const c2Deposit: string = load("T5-c2-quote").response.body.quote.depositAddress;
const c2Page = await send("GET", `https://explorer.near-intents.org/transactions/${c2Deposit}`, {});
const c2Status = await send("GET", `${API}/status?depositAddress=${encodeURIComponent(c2Deposit)}`, {});
const addressReuse = {
  c2DepositAddress: c2Deposit,
  c2ExplorerPage: { http: c2Page.response.status, treasury: mentions(c2Page.response.body, TREASURY), baseAddress: mentions(c2Page.response.body, BASE_ADDRESS) },
  c2Status: { http: c2Status.response.status, treasury: mentions(c2Status.response.body, TREASURY), baseAddress: mentions(c2Status.response.body, BASE_ADDRESS) },
};
const accountTxns = await send("GET", `https://api.nearblocks.io/v1/account/${RECIPIENT}/txns-only?per_page=25`, {});

const summary = {
  depositAddress: q.depositAddress,
  baseHash,
  unauthenticatedStatus: { http: anonStatus.response.status, scan: scan(anonStatus.response.body), message: (anonStatus.response.body as { message?: string })?.message },
  explorerPage: { http: page.response.status, scan: scan(page.response.body), visibleText: visibleText(page.response.body).slice(0, 1200) },
  base: { txFrom: txResult?.from, txTo: txResult?.to, inputMentionsTreasury: mentions(txResult?.input, TREASURY), logsCount: logs.length, logsMentionTreasury: mentions(logs, TREASURY), logsMentionRecipientNear: mentions(logs, RECIPIENT), transfers },
  listedNearTxs: nearTxs.map((n) => ({ hash: n.hash, error: n.error, scan: n.scan, logCount: n.logs.length })),
  nearblocksRecipientTxns: { http: accountTxns.response.status, scan: scan(accountTxns.response.body), body: accountTxns.response.body },
  addressReuse,
};
record("T5d", "privacy", { collectedAt: new Date().toISOString(), summary, raw: { anonStatus, tx, receipt, nearTxs, accountTxns } });
console.log(JSON.stringify(summary, null, 1));
for (const n of nearTxs) for (const l of n.logs) console.log(`${n.hash.slice(0, 6)} ${l.slice(0, 380)}`);
