// T5b and T6, one stage at a time: shield | t6 | payout. Each stage stops on any error, with no retries.
// Never prints or records the secret key. Session tokens are registered for redaction before anything is recorded.
// Run: npx tsx scripts/t5b-t6.ts <stage>
import { readFileSync } from "node:fs";
import { baseEncode, KeyPair, KeyPairSigner, keyToImplicitAddress } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { record, registerSecret } from "../_util.js";

const API = "https://1click.chaindefuser.com/v0";
const NEAR_RPC = "https://rpc.fastnear.com";
const USDC_NEAR_TOKEN = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const SHIELD_AMOUNT = "300000"; // 0.30 USDC
const SHIELD_CAP = 450_000n; // 0.45 USDC may leave the public balance
const PAYOUT_AMOUNT = "100000"; // 0.10 USDC
const PAYOUT_CAP = 110_000n; // 0.11 USDC may leave the confidential balance
const ALLOWED_VERIFIERS = new Set(["intents.near", "intents.far"]);
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
const RECIPIENT = required("CONTRACTOR_EVM_ADDRESS");
const keyPair = KeyPair.fromString(required("TREASURY_SECRET_KEY") as KeyPairString);
if (keyToImplicitAddress(keyPair.getPublicKey()) !== TREASURY) stop("TREASURY_SECRET_KEY does not derive TREASURY_ACCOUNT_ID");

type Token = { assetId: string; blockchain: string; symbol: string; decimals: number; contractAddress: string };
const tokens: Token[] = JSON.parse(readFileSync(new URL("../results/T1-tokens.json", import.meta.url), "utf8")).response.body;
const usdcBase = tokens.find((t) => t.symbol === "USDC" && t.blockchain === "base") ?? stop("USDC on base is missing from T1");

async function publicIntentsBalance() {
  const args = Buffer.from(JSON.stringify({ account_id: TREASURY, token_id: USDC_NEAR_TOKEN })).toString("base64");
  const body = { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", request_type: "call_function", account_id: "intents.near", method_name: "mt_balance_of", args_base64: args } };
  const res = await fetch(NEAR_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const parsed = (await res.json()) as { result?: { result?: number[] } };
  const bytes = parsed.result?.result;
  return { at: new Date().toISOString(), request: { url: NEAR_RPC, body }, status: res.status, response: parsed, value: bytes ? (JSON.parse(Buffer.from(bytes).toString()) as string) : undefined };
}
async function baseUsdcBalance() {
  const data = "0x70a08231" + RECIPIENT.slice(2).toLowerCase().padStart(64, "0");
  const body = { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: usdcBase.contractAddress, data }, "latest"] };
  const res = await fetch("https://mainnet.base.org", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const parsed = (await res.json()) as { result?: string };
  return { at: new Date().toISOString(), status: res.status, response: parsed, value: parsed.result ? BigInt(parsed.result).toString() : undefined };
}
async function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const url = `${API}${path}`;
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
const partner = { "Content-Type": "application/json", "X-API-Key": JWT };

// A failed step is shown in full, so an enablement or permission error is on record verbatim.
function requireOk(step: string, run: { response: { ok: boolean; status: number; body: unknown } }) {
  const body = run.response.body as { correlationId?: string } | string;
  console.log(`${step} | HTTP ${run.response.status} | correlationId ${typeof body === "object" ? body?.correlationId : undefined}`);
  if (!run.response.ok) stop(`${step} failed: ${JSON.stringify(run.response.body)}`);
}

async function signedIntentFlow(label: string, quoteBody: Record<string, unknown>, expected: { cap: bigint; amountField: "amountIn" | "amountOut"; amount: string; source: "public" | "confidential" }) {
  const dry = await send("POST", "/quote", partner, { dry: true, ...quoteBody });
  record("T5b", `${label}-dry`, dry);
  requireOk(`${label} dry quote`, dry);
  const dryQuote = (dry.response.body as { quote: Record<string, string> }).quote;
  console.log(`  ${JSON.stringify(dryQuote)}`);
  if (BigInt(dryQuote.amountIn) > expected.cap) stop(`dry amountIn ${dryQuote.amountIn} is above the cap`);

  const live = await send("POST", "/quote", partner, { dry: false, ...quoteBody });
  record("T5b", `${label}-quote`, live);
  requireOk(`${label} live quote`, live);
  const q = (live.response.body as { quote: Record<string, string> }).quote;
  console.log(`  ${JSON.stringify(q)}`);
  if (BigInt(q.amountIn) > expected.cap) stop(`amountIn ${q.amountIn} is above the cap`);
  if (q[expected.amountField] !== expected.amount) stop(`${expected.amountField} ${q[expected.amountField]} is not the requested ${expected.amount}`);

  const generated = await send("POST", "/generate-intent", partner, { type: "swap_transfer", standard: "nep413", signerId: TREASURY, depositAddress: q.depositAddress });
  record("T5b", `${label}-generate`, generated);
  requireOk(`${label} generate`, generated);
  const intent = (generated.response.body as { intent: { standard: string; payload: Record<string, string> } }).intent;
  console.log(`  Verifier in payload: ${intent.payload.recipient}`);
  console.log(`  Message: ${intent.payload.message}`);

  if (intent.standard !== "nep413") stop(`unexpected standard ${intent.standard}`);
  const payloadKeys = Object.keys(intent.payload).sort().join(",");
  if (payloadKeys !== "message,nonce,recipient") stop(`unexpected payload fields: ${payloadKeys}`);
  if (!ALLOWED_VERIFIERS.has(intent.payload.recipient)) stop(`unexpected verifier ${intent.payload.recipient}`);
  const nonce = Buffer.from(intent.payload.nonce, "base64");
  if (nonce.length !== 32 || nonce.toString("base64") !== intent.payload.nonce) stop("the nonce is not canonical base64 of 32 bytes");
  const message = JSON.parse(intent.payload.message) as { signer_id: string; intents: { intent: string; tokens?: Record<string, string>; diff?: Record<string, string> }[] };
  if (message.signer_id !== TREASURY) stop(`signer_id ${message.signer_id} is not the treasury`);

  // Public USDC, or its confidential form imt:<account>:nep141:<token>. Anything else stops the run.
  let debit = 0n;
  for (const item of message.intents) {
    const entries = item.intent === "transfer" || item.intent === "imt_burn" ? Object.entries(item.tokens ?? {}) : item.intent === "token_diff" ? Object.entries(item.diff ?? {}) : stop(`intent type ${item.intent} cannot be checked against the cap`);
    for (const [token, amount] of entries) {
      const spent = item.intent === "token_diff" ? -BigInt(amount) : BigInt(amount);
      if (spent <= 0n) continue;
      if (token !== USDC_NEAR_TOKEN && !(token.startsWith("imt:") && token.endsWith(`:${USDC_NEAR_TOKEN}`))) stop(`the intent would spend another token: ${token}`);
      // Plain USDC on intents.near is the public balance, which a confidential payout must not touch.
      if (expected.source === "confidential" && intent.payload.recipient === "intents.near" && !token.startsWith("imt:")) stop(`the intent would spend the public balance: ${intent.payload.message}`);
      debit += spent;
    }
  }
  console.log(`  Intent debits ${debit}; cap ${expected.cap}; intent types: ${message.intents.map((i) => i.intent).join(", ")}`);
  if (debit <= 0n) stop("could not find a USDC debit in the intent");
  if (debit > expected.cap) stop(`the intent debit ${debit} is above the cap`);

  const payloadToSign = { message: intent.payload.message, nonce: new Uint8Array(nonce), recipient: intent.payload.recipient };
  const signed = await new KeyPairSigner(keyPair).signNep413Message(TREASURY, payloadToSign);
  const publicKey = signed.publicKey.toString();
  const signature = "ed25519:" + baseEncode(signed.signature);
  const offlineProvider = { viewAccessKey: async () => ({ permission: "FullAccess" }) } as unknown as Parameters<typeof verifyMessage>[0]["provider"];
  await verifyMessage({ signerAccountId: TREASURY, signerPublicKey: publicKey, payload: payloadToSign, signature: signed.signature, provider: offlineProvider }).catch(() => stop("local signature verification failed"));

  const submitted = await send("POST", "/submit-intent", partner, { type: "swap_transfer", signedData: { ...intent, public_key: publicKey, signature } });
  const submittedAt = Date.now();
  record("T5b", `${label}-submit`, submitted);
  requireOk(`${label} submit`, submitted);
  console.log(`  intentHash ${(submitted.response.body as { intentHash?: string }).intentHash}`);

  const statusUrl = `/status?depositAddress=${encodeURIComponent(q.depositAddress)}`;
  const transitions: { at: string; secondsAfterSubmit: number; status: unknown; response: unknown }[] = [];
  const pollErrors: { at: string; error: string }[] = [];
  let last: unknown;
  let polls = 0;
  let terminal = false;
  while (Date.now() < submittedAt + 30 * 60 * 1000) {
    polls++;
    const at = new Date().toISOString();
    try {
      const run = await send("GET", statusUrl, partner);
      const body = run.response.body as { status?: unknown };
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
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  record("T5b", `${label}-status`, { depositAddress: q.depositAddress, submittedAt: new Date(submittedAt).toISOString(), polls, intervalSeconds: 5, transitions, pollErrors, terminal, lastStatus: last });
  console.log(`  Terminal ${terminal}; last status ${String(last)}; polls ${polls}; poll errors ${pollErrors.length}`);
  // What someone without the partner key gets for the same deposit address.
  const unauthenticated = await send("GET", statusUrl, {});
  record("T5b", `${label}-status-unauthenticated`, unauthenticated);
  console.log(`  Unauthenticated status: HTTP ${unauthenticated.response.status}`);
  return { depositAddress: q.depositAddress, lastStatus: last };
}

// The documented NEAR request: an empty intent with a versioned nonce, signed with NEP-413. Only the SDK's nonce
// module is loaded, by file path, because the package root fails to import here and the rest is not needed.
async function currentSalt() {
  const body = { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", request_type: "call_function", account_id: "intents.near", method_name: "current_salt", args_base64: Buffer.from("{}").toString("base64") } };
  const res = await fetch(NEAR_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const parsed = (await res.json()) as { result?: { result?: number[] } };
  const bytes = parsed.result?.result ?? stop("could not read current_salt from intents.near");
  return JSON.parse(Buffer.from(bytes).toString()) as string;
}
type NonceModule = { VersionedNonceBuilder: { createTimestampedNonceBytes(start: Date): Uint8Array; encodeNonce(salt: Uint8Array, deadline: Date, randomBytes: Uint8Array): string } };
async function authenticate(label: string) {
  const modulePath = new URL("../node_modules/@defuse-protocol/intents-sdk/dist/src/intents/expirable-nonce.js", import.meta.url).href;
  const { VersionedNonceBuilder } = (await import(modulePath)) as NonceModule;
  const salt = await currentSalt();
  const deadline = new Date(Date.now() + 5 * 60_000);
  const encodedNonce = VersionedNonceBuilder.encodeNonce(new Uint8Array(Buffer.from(salt, "hex")), deadline, VersionedNonceBuilder.createTimestampedNonceBytes(new Date()));
  const payload = { recipient: "intents.near", nonce: encodedNonce, message: JSON.stringify({ deadline: deadline.toISOString(), intents: [], signer_id: TREASURY }) };
  const signed = await new KeyPairSigner(keyPair).signNep413Message(TREASURY, { message: payload.message, nonce: new Uint8Array(Buffer.from(encodedNonce, "base64")), recipient: payload.recipient });
  const signedData = { standard: "nep413", payload, public_key: signed.publicKey.toString(), signature: "ed25519:" + baseEncode(signed.signature) };
  const auth = await send("POST", "/auth/authenticate", { "Content-Type": "application/json" }, { signedData });
  const body = auth.response.body as { accessToken?: string; refreshToken?: string; expiresIn?: number; refreshExpiresIn?: number };
  registerSecret(body?.accessToken);
  registerSecret(body?.refreshToken);
  record("T6", `${label}-authenticate`, { saltFromContract: salt, ...auth });
  requireOk(`${label} authenticate`, auth);
  console.log(`  salt ${salt}; expiresIn ${body.expiresIn}; refreshExpiresIn ${body.refreshExpiresIn}`);
  return body as { accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresIn: number };
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
async function confidentialBalances(label: string, token: string) {
  const run = await send("GET", "/account/balances", bearer(token));
  record("T6", `${label}-balances`, run);
  requireOk(`${label} balances`, run);
  console.log(`  ${JSON.stringify(run.response.body)}`);
  return run;
}

const stage = process.argv[2];
if (stage === "shield") {
  const before = await publicIntentsBalance();
  console.log(`Public Intents USDC before: ${before.value}`);
  if (before.value === undefined) stop("could not read the public balance");
  const result = await signedIntentFlow(
    "shield",
    {
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: USDC_NEAR_TOKEN,
      depositType: "INTENTS",
      destinationAsset: USDC_NEAR_TOKEN,
      amount: SHIELD_AMOUNT,
      recipient: TREASURY,
      recipientType: "CONFIDENTIAL_INTENTS",
      refundTo: TREASURY,
      refundType: "INTENTS",
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
    { cap: SHIELD_CAP, amountField: "amountIn", amount: SHIELD_AMOUNT, source: "public" },
  );
  const after = await publicIntentsBalance();
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  const settled = await publicIntentsBalance();
  record("T5b", "shield-public-balance", { before, after, settled, result });
  console.log(`Public Intents USDC after: ${after.value}; after 60s: ${settled.value}`);
} else if (stage === "shield-check") {
  // Read-only. The shield poller was stopped before it wrote its status record, so this reads the outcome afterwards.
  const quote = JSON.parse(readFileSync(new URL("../results/T5b-shield-quote.json", import.meta.url), "utf8"));
  const depositAddress: string = quote.response.body.quote.depositAddress;
  const status = await send("GET", `/status?depositAddress=${encodeURIComponent(depositAddress)}`, {});
  const authenticated = await send("GET", `/status?depositAddress=${encodeURIComponent(depositAddress)}`, partner);
  console.log(`Status with partner key, HTTP ${authenticated.response.status}: ${JSON.stringify(authenticated.response.body)}`);
  const balance = await publicIntentsBalance();
  record("T5b", "shield-status-after-pause", { note: "Polling was stopped at the founder's request; intermediate transitions were not recorded.", unauthenticatedStatus: status, authenticatedStatus: authenticated, publicBalance: balance });
  console.log(`Status HTTP ${status.response.status}: ${JSON.stringify(status.response.body)}`);
  console.log(`Public Intents USDC now: ${balance.value}`);
} else if (stage === "t6") {
  const auth = await authenticate("t6");
  await confidentialBalances("t6", auth.accessToken);
  const history = await send("GET", "/account/history", bearer(auth.accessToken));
  record("T6", "t6-history", history);
  requireOk("t6 history", history);
  console.log(`  History top-level keys: ${Object.keys(history.response.body as object).join(", ")}`);
  const refreshed = await send("POST", "/auth/refresh", { "Content-Type": "application/json" }, { refreshToken: auth.refreshToken });
  const refreshBody = refreshed.response.body as { accessToken?: string; expiresIn?: number };
  registerSecret(refreshBody?.accessToken);
  record("T6", "t6-refresh", refreshed);
  requireOk("t6 refresh", refreshed);
  console.log(`  Refresh keys: ${Object.keys(refreshBody).join(", ")}; expiresIn ${refreshBody.expiresIn}`);
} else if (stage === "refresh") {
  const auth = await authenticate("refresh");
  const refreshed = await send("POST", "/auth/refresh", { "Content-Type": "application/json" }, { refreshToken: auth.refreshToken });
  const refreshBody = refreshed.response.body as { accessToken?: string; refreshToken?: string; expiresIn?: number };
  registerSecret(refreshBody?.accessToken);
  registerSecret(refreshBody?.refreshToken);
  record("T6", "t6-refresh", refreshed);
  requireOk("refresh", refreshed);
  console.log(`  Refresh response keys: ${Object.keys(refreshBody).join(", ")}; expiresIn ${refreshBody.expiresIn}`);
  await confidentialBalances("refresh-new-token", refreshBody.accessToken as string);
} else if (stage === "payout") {
  const auth = await authenticate("payout-before");
  const confidentialBefore = await confidentialBalances("payout-before", auth.accessToken);
  const before = { public: await publicIntentsBalance(), base: await baseUsdcBalance() };
  console.log(`Public Intents USDC before: ${before.public.value}; Base USDC before: ${before.base.value}`);
  const result = await signedIntentFlow(
    "payout",
    {
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: USDC_NEAR_TOKEN,
      depositType: "CONFIDENTIAL_INTENTS",
      destinationAsset: usdcBase.assetId,
      amount: PAYOUT_AMOUNT,
      recipient: RECIPIENT,
      recipientType: "DESTINATION_CHAIN",
      refundTo: TREASURY,
      refundType: "CONFIDENTIAL_INTENTS",
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
    { cap: PAYOUT_CAP, amountField: "amountOut", amount: PAYOUT_AMOUNT, source: "confidential" },
  );
  const after = { public: await publicIntentsBalance(), base: await baseUsdcBalance() };
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  const settled = { public: await publicIntentsBalance(), base: await baseUsdcBalance() };
  const authAfter = await authenticate("payout-after");
  const confidentialAfter = await confidentialBalances("payout-after", authAfter.accessToken);
  record("T5b", "payout-balances", { before, after, settled, confidentialBefore: confidentialBefore.response.body, confidentialAfter: confidentialAfter.response.body, result });
  console.log(`Public Intents USDC after: ${after.public.value}; after 60s: ${settled.public.value}; Base USDC after: ${after.base.value}; after 60s: ${settled.base.value}`);
} else {
  stop("Usage: t5b-t6.ts shield | t6 | payout");
}
