// Spike S-E2: does a payload signed before the quote deadline execute when submitted after it?
// Hard cap: 0.06 USDC leaving the treasury's public Intents balance. Moves real funds.
// Never prints or records the secret key. Submit is never retried. Run: npx tsx scripts/s-e2.ts
import { baseEncode, KeyPair, KeyPairSigner, keyToImplicitAddress } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { record } from "../_util.js";

const API = "https://1click.chaindefuser.com/v0";
const NEAR_RPC = "https://rpc.fastnear.com";
const BASE_RPC = "https://mainnet.base.org";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDC_BASE_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CAP = 60_000n;
const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
function stop(reason: string): never {
  log(`STOPPED: ${reason}`);
  process.exit(1);
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) stop(`${name} is not set`);
  return value as string;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const JWT = required("ONECLICK_JWT");
const TREASURY = required("TREASURY_ACCOUNT_ID");
const RECIPIENT = required("CONTRACTOR_EVM_ADDRESS");
const keyPair = KeyPair.fromString(required("TREASURY_SECRET_KEY") as KeyPairString);
if (keyToImplicitAddress(keyPair.getPublicKey()) !== TREASURY) stop("the key does not derive the treasury");

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= 4) throw err;
      log(`  network error, retry ${attempt}`);
      await sleep(10_000);
    }
  }
}
async function rpc(url: string, body: unknown) {
  return withRetry(async () => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return (await res.json()) as any;
  });
}
async function balances() {
  const args = Buffer.from(JSON.stringify({ account_id: TREASURY, token_id: USDC })).toString("base64");
  const near = await rpc(NEAR_RPC, { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", request_type: "call_function", account_id: "intents.near", method_name: "mt_balance_of", args_base64: args } });
  const data = "0x70a08231" + RECIPIENT.slice(2).toLowerCase().padStart(64, "0");
  const base = await rpc(BASE_RPC, { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE_CONTRACT, data }, "latest"] });
  const bytes = near.result?.result;
  if (!bytes || !base.result) stop("could not read balances");
  return { at: new Date().toISOString(), intents: JSON.parse(Buffer.from(bytes).toString()) as string, base: BigInt(base.result).toString() };
}
/** Reads retry; a submit never does, since it could pay twice. */
async function api(method: "GET" | "POST", path: string, body?: unknown, retry = true) {
  const once = async () => {
    const res = await fetch(`${API}${path}`, { method, headers: { "Content-Type": "application/json", "X-API-Key": JWT }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON is kept verbatim.
    }
    return { at: new Date().toISOString(), path, request: body ?? null, status: res.status, body: parsed as any };
  };
  return retry ? withRetry(once) : once();
}

const start = await balances();
record("S-E2", "balances-start", start);
log(`Start: Intents ${start.intents}; Base ${start.base}`);
const startIntents = BigInt(start.intents);
const startBase = BigInt(start.base);

const requestedDeadline = new Date(Date.now() + 60_000);
const quote = await api("POST", "/quote", {
  dry: false,
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 100,
  originAsset: USDC,
  depositType: "INTENTS",
  destinationAsset: USDC_BASE,
  amount: "50000",
  recipient: RECIPIENT,
  recipientType: "DESTINATION_CHAIN",
  refundTo: TREASURY,
  refundType: "INTENTS",
  deadline: requestedDeadline.toISOString(),
});
record("S-E2", "quote", quote);
const q = quote.body?.quote ?? stop(`the quote failed: HTTP ${quote.status} ${quote.body?.message}`);
const echoedDeadline: string = quote.body.quoteRequest?.deadline;
log(`Quote: deposit ${q.depositAddress}; amountIn ${q.amountIn}; requested ${requestedDeadline.toISOString()}; echoed request ${echoedDeadline}; quote deadline ${q.deadline}`);

const generated = await api("POST", "/generate-intent", { type: "swap_transfer", standard: "nep413", signerId: TREASURY, depositAddress: q.depositAddress });
record("S-E2", "generate", generated);
const payload = generated.body?.intent?.payload ?? stop(`generate failed: HTTP ${generated.status} ${generated.body?.message}`);
const message = JSON.parse(payload.message) as { deadline: string; signer_id: string; intents: { intent: string; receiver_id?: string; tokens?: Record<string, string> }[] };
const item = message.intents[0];
const entries = Object.entries(item?.tokens ?? {});
if (message.signer_id !== TREASURY || message.intents.length !== 1 || item?.intent !== "transfer" || item.receiver_id !== q.depositAddress || entries.length !== 1 || entries[0]?.[0] !== USDC) stop("the generated intent isn't the expected transfer");
const debit = BigInt(entries[0]?.[1] as string);
if (debit > CAP) stop(`the intent debits ${debit}, above the cap`);
if (debit > startIntents) stop("the intent debits more than the balance");

const signed = await new KeyPairSigner(keyPair).signNep413Message(TREASURY, { message: payload.message, nonce: new Uint8Array(Buffer.from(payload.nonce, "base64")), recipient: payload.recipient });
const signedData = { standard: "nep413", payload, public_key: signed.publicKey.toString(), signature: "ed25519:" + baseEncode(signed.signature) };
const deadlines = {
  requested: requestedDeadline.toISOString(),
  echoedRequest: echoedDeadline,
  quote: q.deadline,
  quoteTimeWhenInactive: q.timeWhenInactive,
  signedMessage: message.deadline,
  signedAt: new Date().toISOString(),
  debit: debit.toString(),
};
record("S-E2", "deadlines", deadlines);
log(`Signed. Deadlines: requested ${deadlines.requested}; echoed ${deadlines.echoedRequest}; quote ${deadlines.quote}; signed message ${deadlines.signedMessage}; debit ${debit}`);

const latest = Math.max(requestedDeadline.getTime(), Date.parse(echoedDeadline));
if (Date.parse(message.deadline) <= latest + 10_000) stop("the signed message's deadline isn't after the quote deadline, so the test can't run");
const wait = latest + 5_000 - Date.now();
if (wait > 0) await sleep(wait);
const statusBefore = await api("GET", `/status?depositAddress=${encodeURIComponent(q.depositAddress)}`);
record("S-E2", "status-before-submit", statusBefore);
log(`Before the late submit: status ${statusBefore.body?.status}; message deadline still ahead: ${Date.parse(message.deadline) > Date.now()}`);
if (Date.parse(message.deadline) <= Date.now()) stop("the signed message's deadline has already passed");

const submit = await api("POST", "/submit-intent", { type: "swap_transfer", signedData }, false);
record("S-E2", "late-submit", submit);
log(`Late submit, ${(Date.now() - latest) / 1000}s after the quote deadline: HTTP ${submit.status} ${submit.body?.intentHash ?? ""} ${submit.body?.message ?? ""}`);

const seen: { at: string; status: unknown; http: number }[] = [];
const until = Date.now() + 10 * 60_000;
let last: any;
while (Date.now() < until) {
  last = await api("GET", `/status?depositAddress=${encodeURIComponent(q.depositAddress)}`);
  const s = last.body?.status;
  if (seen.at(-1)?.status !== s) {
    seen.push({ at: last.at, status: s ?? null, http: last.status });
    log(`  status: ${s ?? `HTTP ${last.status}`}`);
    record("S-E2", "status", { seen, last });
  }
  const now = await balances();
  if (startIntents - BigInt(now.intents) > CAP) stop(`CAP BREACHED: Intents ${now.intents}`);
  if (TERMINAL.has(s)) break;
  await sleep(10_000);
}
record("S-E2", "status", { seen, last });

await sleep(60_000); // Let any refund of the slippage buffer land.
const end = await balances();
record("S-E2", "balances-end", { start, end });
log(`End: Intents ${end.intents} (left ${startIntents - BigInt(end.intents)}, cap ${CAP}); Base ${end.base} (+${BigInt(end.base) - startBase})`);
log("DONE");
