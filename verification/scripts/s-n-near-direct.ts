// Spike S-N (slice W3, L46): one direct PUBLIC USDC payout from the dev treasury's NEAR Intents
// balance to a NEAR named account, EXACT_OUTPUT, at most 0.10 USDC (L11 cap).
// Records the quote, the generated and signed intent, the submit, every status transition, the
// recipient's USDC balance before and after, and the NEAR explorer transactions.
//
// MAINNET. NOT RUN in slice W3: it needs the founder's explicit approval, given by setting
// S_N_FOUNDER_APPROVED=yes for the one run. Stops on any error, with no retries. Refuses to sign
// unless the intent's debit is provably within the cap. Never prints or records the secret key.
// Run (only after approval): npx tsx scripts/s-n-near-direct.ts
import { readFileSync } from "node:fs";
import { baseEncode, KeyPair, KeyPairSigner, keyToImplicitAddress } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { record } from "../_util.js";

const API = "https://1click.chaindefuser.com/v0";
const NEAR_RPC = "https://rpc.fastnear.com";
const USDC_NEAR_TOKEN = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_NEAR_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const CAP = 100_000n; // 0.10 USDC, 6 decimals (L11)
const PAYOUT = "100000"; // 0.10 USDC: the debit includes fees, so it must still be <= CAP
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);
const NAMED_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*\.near$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) stop(`${name} is not set`);
  return value as string;
}
function stop(reason: string): never {
  console.log(`STOPPED: ${reason}`);
  process.exit(1);
}

if (process.env.S_N_FOUNDER_APPROVED !== "yes") {
  stop("S-N is a mainnet payout. Set S_N_FOUNDER_APPROVED=yes only for the run the founder approved.");
}
const JWT = required("ONECLICK_JWT");
const TREASURY = required("TREASURY_ACCOUNT_ID");
const RECIPIENT = required("CONTRACTOR_NEAR_ACCOUNT");
if (!NAMED_ACCOUNT.test(RECIPIENT)) stop("CONTRACTOR_NEAR_ACCOUNT must be a NEAR named account (*.near)");
if (RECIPIENT === TREASURY) stop("the recipient must not be the treasury");
const keyPair = KeyPair.fromString(required("TREASURY_SECRET_KEY") as KeyPairString);
if (keyToImplicitAddress(keyPair.getPublicKey()) !== TREASURY) stop("TREASURY_SECRET_KEY does not derive TREASURY_ACCOUNT_ID");

type Token = { assetId: string; blockchain: string; symbol: string; decimals: number };
const tokens: Token[] = JSON.parse(readFileSync(new URL("../results/T1-tokens.json", import.meta.url), "utf8")).response.body;
const usdcNear = tokens.find((t) => t.assetId === USDC_NEAR_TOKEN);
if (!usdcNear || usdcNear.decimals !== 6 || usdcNear.symbol !== "USDC") stop("USDC on NEAR is not as expected in T1");

async function nearView(params: Record<string, unknown>) {
  const body = { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", ...params } };
  const res = await fetch(NEAR_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return { request: { url: NEAR_RPC, body }, status: res.status, response: (await res.json()) as { result?: { result?: number[] }; error?: unknown } };
}
async function viewNumber(account: string, method: string, args: Record<string, string>) {
  const raw = await nearView({ request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  const bytes = raw.response.result?.result;
  return { at: new Date().toISOString(), raw, value: bytes ? (JSON.parse(Buffer.from(bytes).toString()) as string) : undefined };
}
const intentsBalance = () => viewNumber("intents.near", "mt_balance_of", { account_id: TREASURY, token_id: USDC_NEAR_TOKEN });
const recipientUsdc = () => viewNumber(USDC_NEAR_CONTRACT, "ft_balance_of", { account_id: RECIPIENT });

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

// 1. Balances first, so "before" is on record even if a later step stops the run.
const before = { intents: await intentsBalance(), recipient: await recipientUsdc() };
record("S-N", "balances-before", before);
console.log(`Before: treasury Intents USDC ${before.intents.value}; recipient USDC ${before.recipient.value}`);
if (before.intents.value === undefined || before.recipient.value === undefined) stop("could not read the starting balances");

// 2. Live quote: public USDC from the treasury's Intents balance to a NEAR account.
const quote = await api("/quote", {
  dry: false,
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 100,
  originAsset: USDC_NEAR_TOKEN,
  depositType: "INTENTS",
  destinationAsset: USDC_NEAR_TOKEN,
  amount: PAYOUT,
  recipient: RECIPIENT,
  recipientType: "DESTINATION_CHAIN",
  refundTo: TREASURY,
  refundType: "INTENTS",
  deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
});
record("S-N", "quote", quote);
const quoteBody = quote.response.body as { message?: string; correlationId?: string; quote?: Record<string, string> };
console.log(`Quote | HTTP ${quote.response.status} | correlationId ${quoteBody.correlationId} | ${quoteBody.message ?? JSON.stringify(quoteBody.quote)}`);
if (!quote.response.ok || !quoteBody.quote) stop("the live quote failed");
const q = quoteBody.quote;
if (BigInt(q.amountIn) > CAP) stop(`amountIn ${q.amountIn} is above the 0.10 USDC cap`);
if (BigInt(q.amountIn) > BigInt(before.intents.value as string)) stop("amountIn is above the Intents balance");
if (q.amountOut !== PAYOUT) stop(`amountOut ${q.amountOut} is not the requested ${PAYOUT}`);

// 3. Generate the intent.
const generated = await api("/generate-intent", { type: "swap_transfer", standard: "nep413", signerId: TREASURY, depositAddress: q.depositAddress });
record("S-N", "generate-intent", generated);
const genBody = generated.response.body as { message?: string; correlationId?: string; intent?: { standard: string; payload: Record<string, string> } };
if (!generated.response.ok || !genBody.intent) stop("generate-intent failed");
const intent = genBody.intent;

// 4. Checks on the unsigned payload. Nothing is signed unless all of them pass.
if (intent.standard !== "nep413") stop(`unexpected standard ${intent.standard}`);
if (Object.keys(intent.payload).sort().join(",") !== "message,nonce,recipient") stop("unexpected payload fields");
if (intent.payload.recipient !== "intents.near") stop(`unexpected verifier ${intent.payload.recipient}: a public payout must sign for intents.near`);
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
console.log(`Intent debits ${debit} (cap ${CAP}); intent types: ${message.intents.map((i) => i.intent).join(", ")}`);
if (debit <= 0n || debit > CAP) stop(`the intent debit ${debit} is outside (0, cap]`);

// 5. Sign unmodified, verify locally, record the signed intent (public key and signature only).
const payloadToSign = { message: intent.payload.message, nonce: new Uint8Array(nonce), recipient: intent.payload.recipient };
const signed = await new KeyPairSigner(keyPair).signNep413Message(TREASURY, payloadToSign);
const publicKey = signed.publicKey.toString();
const signature = "ed25519:" + baseEncode(signed.signature);
const offlineProvider = { viewAccessKey: async () => ({ permission: "FullAccess" }) } as unknown as Parameters<typeof verifyMessage>[0]["provider"];
await verifyMessage({ signerAccountId: TREASURY, signerPublicKey: publicKey, payload: payloadToSign, signature: signed.signature, provider: offlineProvider }).catch(() => stop("local signature verification failed"));
record("S-N", "signed-intent", { intent, public_key: publicKey, signature });

// 6. Submit.
const submitted = await api("/submit-intent", { type: "swap_transfer", signedData: { ...intent, public_key: publicKey, signature } });
record("S-N", "submit-intent", submitted);
const submitBody = submitted.response.body as { intentHash?: string; message?: string };
const submittedAt = Date.now();
if (!submitted.response.ok || !submitBody.intentHash) stop("submit-intent failed");
console.log(`Submit | intentHash ${submitBody.intentHash}`);

// 7. Poll status until terminal (30 min max); record every transition and the NEAR tx hashes.
const statusUrl = `${API}/status?depositAddress=${encodeURIComponent(q.depositAddress)}`;
const transitions: { at: string; status: unknown; body: unknown }[] = [];
let last: unknown;
let terminal = false;
while (Date.now() < submittedAt + 30 * 60 * 1000) {
  try {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(30_000) });
    const body = (await res.json()) as { status?: string };
    if (body.status !== last) {
      transitions.push({ at: new Date().toISOString(), status: body.status, body });
      last = body.status;
      record("S-N", "status", { depositAddress: q.depositAddress, transitions });
      console.log(`${new Date().toISOString()} ${String(body.status)}`);
    }
    if (body.status && TERMINAL.has(body.status)) {
      terminal = true;
      break;
    }
  } catch (err) {
    transitions.push({ at: new Date().toISOString(), status: "poll-error", body: err instanceof Error ? err.message : String(err) });
  }
  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

// 8. Balances after, then the explorer links for each NEAR transaction in the final status.
await new Promise((resolve) => setTimeout(resolve, 60_000));
const after = { intents: await intentsBalance(), recipient: await recipientUsdc() };
const finalBody = transitions.at(-1)?.body as { swapDetails?: { nearTxHashes?: string[]; destinationChainTxHashes?: { hash: string }[] } } | undefined;
const nearTxs = [...(finalBody?.swapDetails?.nearTxHashes ?? []), ...(finalBody?.swapDetails?.destinationChainTxHashes ?? []).map((t) => t.hash)];
record("S-N", "result", {
  terminal,
  lastStatus: last,
  before,
  after,
  recipientDelta: after.recipient.value && before.recipient.value ? (BigInt(after.recipient.value) - BigInt(before.recipient.value)).toString() : undefined,
  explorer: nearTxs.map((h) => `https://nearblocks.io/txns/${h}`),
});
console.log(`Terminal: ${terminal}; last status ${String(last)}; recipient USDC ${before.recipient.value} -> ${after.recipient.value}`);
for (const h of nearTxs) console.log(`https://nearblocks.io/txns/${h}`);
