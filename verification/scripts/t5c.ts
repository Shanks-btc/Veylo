// T5c: confidential treasury to confidential recipient, EXACT_OUTPUT 0.05 USDC, then a public-source privacy check.
// Stops on any error, with no retries. Never prints or records a secret key; session tokens are registered for redaction.
// Run: npx tsx scripts/t5c.ts
import { baseEncode, KeyPair, KeyPairSigner, keyToImplicitAddress } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { record, registerSecret } from "../_util.js";

const API = "https://1click.chaindefuser.com/v0";
const NEAR_RPC = "https://rpc.fastnear.com";
const USDC_NEAR_TOKEN = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const AMOUNT = "50000"; // 0.05 USDC
const CAP = 60_000n; // 0.06 USDC may leave the treasury's confidential balance
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
const treasuryKey = KeyPair.fromString(required("TREASURY_SECRET_KEY") as KeyPairString);
const recipientKey = KeyPair.fromString(required("RECIPIENT_NEAR_SECRET_KEY") as KeyPairString);
if (keyToImplicitAddress(treasuryKey.getPublicKey()) !== TREASURY) stop("TREASURY_SECRET_KEY does not derive TREASURY_ACCOUNT_ID");
if (keyToImplicitAddress(recipientKey.getPublicKey()) !== RECIPIENT) stop("RECIPIENT_NEAR_SECRET_KEY does not derive RECIPIENT_NEAR_ACCOUNT_ID");
const partner = { "Content-Type": "application/json", "X-API-Key": JWT };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mentions = (value: unknown, needle: string) => JSON.stringify(value ?? null).toLowerCase().includes(needle.toLowerCase());

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
async function nearView(method: string, args: unknown, accountId = "intents.near") {
  const body = { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", request_type: "call_function", account_id: accountId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } };
  const res = await fetch(NEAR_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const parsed = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
  const bytes = parsed.result?.result;
  return { at: new Date().toISOString(), request: { url: NEAR_RPC, body }, status: res.status, response: parsed, value: bytes ? (JSON.parse(Buffer.from(bytes).toString()) as unknown) : undefined };
}
// What anyone can read about an account on the public contract and chain.
async function publicState(accountId: string) {
  const balance = await nearView("mt_balance_of", { account_id: accountId, token_id: USDC_NEAR_TOKEN });
  const tokens = await nearView("mt_tokens_for_owner", { account_id: accountId, limit: 50 });
  const accountBody = { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", request_type: "view_account", account_id: accountId } };
  const accountRes = await fetch(NEAR_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(accountBody), signal: AbortSignal.timeout(30_000) });
  const account = (await accountRes.json()) as { result?: { amount?: string } };
  return { at: new Date().toISOString(), publicUsdc: balance.value, tokensOwned: tokens.value, tokensError: tokens.value === undefined ? tokens.response : undefined, accountExistsOnChain: Boolean(account.result?.amount), rawBalance: balance };
}

async function session(label: string, accountId: string, key: KeyPair) {
  const modulePath = new URL("../node_modules/@defuse-protocol/intents-sdk/dist/src/intents/expirable-nonce.js", import.meta.url).href;
  const { VersionedNonceBuilder } = (await import(modulePath)) as { VersionedNonceBuilder: { createTimestampedNonceBytes(start: Date): Uint8Array; encodeNonce(salt: Uint8Array, deadline: Date, randomBytes: Uint8Array): string } };
  const saltRead = await nearView("current_salt", {});
  if (typeof saltRead.value !== "string") stop("could not read current_salt from intents.near");
  const deadline = new Date(Date.now() + 5 * 60_000);
  const encodedNonce = VersionedNonceBuilder.encodeNonce(new Uint8Array(Buffer.from(saltRead.value, "hex")), deadline, VersionedNonceBuilder.createTimestampedNonceBytes(new Date()));
  const payload = { recipient: "intents.near", nonce: encodedNonce, message: JSON.stringify({ deadline: deadline.toISOString(), intents: [], signer_id: accountId }) };
  const signed = await new KeyPairSigner(key).signNep413Message(accountId, { message: payload.message, nonce: new Uint8Array(Buffer.from(encodedNonce, "base64")), recipient: payload.recipient });
  const signedData = { standard: "nep413", payload, public_key: signed.publicKey.toString(), signature: "ed25519:" + baseEncode(signed.signature) };
  const auth = await send("POST", `${API}/auth/authenticate`, { "Content-Type": "application/json" }, { signedData });
  const body = auth.response.body as { accessToken?: string; refreshToken?: string };
  registerSecret(body?.accessToken);
  registerSecret(body?.refreshToken);
  record("T5c", `${label}-authenticate`, auth);
  requireOk(`${label} authenticate`, auth);
  const balances = await send("GET", `${API}/account/balances`, { Authorization: `Bearer ${body.accessToken}` });
  record("T5c", `${label}-balances`, balances);
  requireOk(`${label} balances`, balances);
  console.log(`  ${JSON.stringify(balances.response.body)}`);
  return balances.response.body;
}

// Both sessions and public states are read first: a failure here stops the run with nothing spent.
const before = {
  treasuryConfidential: await session("treasury-before", TREASURY, treasuryKey),
  recipientConfidential: await session("recipient-before", RECIPIENT, recipientKey),
  treasuryPublic: await publicState(TREASURY),
  recipientPublic: await publicState(RECIPIENT),
};
record("T5c", "balances-before", before);
console.log(`Public before: treasury ${JSON.stringify(before.treasuryPublic.publicUsdc)}; recipient ${JSON.stringify(before.recipientPublic.publicUsdc)}; recipient account exists: ${before.recipientPublic.accountExistsOnChain}`);

const quoteBody = {
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 100,
  originAsset: USDC_NEAR_TOKEN,
  depositType: "CONFIDENTIAL_INTENTS",
  destinationAsset: USDC_NEAR_TOKEN,
  amount: AMOUNT,
  recipient: RECIPIENT,
  recipientType: "CONFIDENTIAL_INTENTS",
  refundTo: TREASURY,
  refundType: "CONFIDENTIAL_INTENTS",
  deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
};
const dry = await send("POST", `${API}/quote`, partner, { dry: true, ...quoteBody });
record("T5c", "dry", dry);
requireOk("dry quote", dry);
const dryQuote = (dry.response.body as { quote: Record<string, string> }).quote;
console.log(`  ${JSON.stringify(dryQuote)}`);
if (BigInt(dryQuote.amountIn) > CAP) stop(`dry amountIn ${dryQuote.amountIn} is above the cap`);

const live = await send("POST", `${API}/quote`, partner, { dry: false, ...quoteBody });
record("T5c", "quote", live);
requireOk("live quote", live);
const q = (live.response.body as { quote: Record<string, string> }).quote;
console.log(`  ${JSON.stringify(q)}`);
if (BigInt(q.amountIn) > CAP) stop(`amountIn ${q.amountIn} is above the cap`);
if (q.amountOut !== AMOUNT) stop(`amountOut ${q.amountOut} is not the requested ${AMOUNT}`);

const generated = await send("POST", `${API}/generate-intent`, partner, { type: "swap_transfer", standard: "nep413", signerId: TREASURY, depositAddress: q.depositAddress });
record("T5c", "generate", generated);
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
if (message.signer_id !== TREASURY) stop(`signer_id ${message.signer_id} is not the treasury`);
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

// Same signing lines as C2.
const payloadToSign = { message: intent.payload.message, nonce: new Uint8Array(nonce), recipient: intent.payload.recipient };
const signed = await new KeyPairSigner(treasuryKey).signNep413Message(TREASURY, payloadToSign);
const publicKey = signed.publicKey.toString();
const signature = "ed25519:" + baseEncode(signed.signature);
const offlineProvider = { viewAccessKey: async () => ({ permission: "FullAccess" }) } as unknown as Parameters<typeof verifyMessage>[0]["provider"];
await verifyMessage({ signerAccountId: TREASURY, signerPublicKey: publicKey, payload: payloadToSign, signature: signed.signature, provider: offlineProvider }).catch(() => stop("local signature verification failed"));

const submitted = await send("POST", `${API}/submit-intent`, partner, { type: "swap_transfer", signedData: { ...intent, public_key: publicKey, signature } });
const submittedAt = Date.now();
record("T5c", "submit", submitted);
requireOk("submit", submitted);
console.log(`  intentHash ${(submitted.response.body as { intentHash?: string }).intentHash}`);

const statusUrl = `${API}/status?depositAddress=${encodeURIComponent(q.depositAddress)}`;
const transitions: { at: string; secondsAfterSubmit: number; status: unknown; response: unknown }[] = [];
const pollErrors: { at: string; error: string }[] = [];
let last: unknown;
let lastBody: { status?: unknown; swapDetails?: { nearTxHashes?: string[]; destinationChainTxHashes?: { hash: string }[] } } | undefined;
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
      console.log(`  ${at} ${String(last)}`);
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
record("T5c", "status", { depositAddress: q.depositAddress, submittedAt: new Date(submittedAt).toISOString(), polls, intervalSeconds: 5, transitions, pollErrors, terminal, lastStatus: last });
console.log(`Terminal ${terminal}; last status ${String(last)}; polls ${polls}; poll errors ${pollErrors.length}`);
console.log(`Details: ${JSON.stringify(lastBody?.swapDetails)}`);

await sleep(30_000);
const after = {
  treasuryConfidential: await session("treasury-after", TREASURY, treasuryKey),
  recipientConfidential: await session("recipient-after", RECIPIENT, recipientKey),
  treasuryPublic: await publicState(TREASURY),
  recipientPublic: await publicState(RECIPIENT),
};
record("T5c", "balances-after", after);
console.log(`Public after: treasury ${JSON.stringify(after.treasuryPublic.publicUsdc)}, tokens ${JSON.stringify(after.treasuryPublic.tokensOwned)}`);
console.log(`Public after: recipient ${JSON.stringify(after.recipientPublic.publicUsdc)}, tokens ${JSON.stringify(after.recipientPublic.tokensOwned)}, account exists ${after.recipientPublic.accountExistsOnChain}`);

// Privacy check. None of these requests carry credentials.
const visibleText = (html: unknown) => (typeof html === "string" ? html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
const amounts = [AMOUNT, q.amountIn, q.minAmountIn];
const scan = (value: unknown) => ({ treasury: mentions(value, TREASURY), recipient: mentions(value, RECIPIENT), depositAddress: mentions(value, q.depositAddress), amounts: amounts.filter((a) => mentions(value, a)) });

const anonStatus = await send("GET", statusUrl, {});
const pages = [];
for (const [label, id] of [["deposit", q.depositAddress], ["recipient", RECIPIENT], ["treasury", TREASURY]] as const) {
  const page = await send("GET", `https://explorer.near-intents.org/transactions/${id}`, {});
  pages.push({ label, id, http: page.response.status, bytes: typeof page.response.body === "string" ? page.response.body.length : undefined, scan: scan(page.response.body), visibleText: visibleText(page.response.body).slice(0, 1500) });
}
const accountTxns = await send("GET", `https://api.nearblocks.io/v1/account/${RECIPIENT}/txns-only?per_page=25`, {});
const nearHashes = lastBody?.swapDetails?.nearTxHashes ?? [];
const nearTxs = [];
for (const hash of nearHashes) {
  const body = { jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: "intents.near", wait_until: "NONE" } };
  const res = await fetch(NEAR_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  const parsed = (await res.json()) as { result?: { receipts_outcome?: { outcome: { logs: string[] } }[] }; error?: unknown };
  const logs = (parsed.result?.receipts_outcome ?? []).flatMap((o) => o.outcome.logs);
  nearTxs.push({ hash, error: parsed.error, scan: scan(parsed.result), logs, raw: parsed });
  await sleep(1_500);
}
const summary = {
  depositAddress: q.depositAddress,
  unauthenticatedStatus: { http: anonStatus.response.status, scan: scan(anonStatus.response.body), body: anonStatus.response.body },
  explorerPages: pages,
  nearblocksRecipientTxns: { http: accountTxns.response.status, scan: scan(accountTxns.response.body), body: accountTxns.response.body },
  listedNearTxs: nearTxs.map((n) => ({ hash: n.hash, error: n.error, scan: n.scan, logCount: n.logs.length })),
  publicBefore: { treasury: before.treasuryPublic.publicUsdc, recipient: before.recipientPublic.publicUsdc, recipientTokens: before.recipientPublic.tokensOwned, recipientExists: before.recipientPublic.accountExistsOnChain },
  publicAfter: { treasury: after.treasuryPublic.publicUsdc, recipient: after.recipientPublic.publicUsdc, recipientTokens: after.recipientPublic.tokensOwned, recipientExists: after.recipientPublic.accountExistsOnChain },
};
record("T5c", "privacy", { collectedAt: new Date().toISOString(), summary, nearTxs });
console.log(JSON.stringify(summary, null, 1).slice(0, 6000));
for (const n of nearTxs) for (const l of n.logs.slice(0, 6)) console.log(`${n.hash.slice(0, 6)} ${l.slice(0, 340)}`);
