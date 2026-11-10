// Spike S-E: expired quote, replay, and the status of a never-funded quote. Moves real funds.
// Hard cap: 0.10 USDC leaving the treasury's public Intents balance. Stops on any unexpected movement.
// Never prints or records the secret key. Run: npx tsx scripts/s-e.ts
import { baseEncode, KeyPair, KeyPairSigner, keyToImplicitAddress } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { record } from "../_util.js";

const API = "https://1click.chaindefuser.com/v0";
const NEAR_RPC = "https://rpc.fastnear.com";
const BASE_RPC = "https://mainnet.base.org";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDC_BASE_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CAP = 100_000n;
const PAYOUT = "50000";
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

async function intentsBalance(): Promise<bigint> {
  const args = Buffer.from(JSON.stringify({ account_id: TREASURY, token_id: USDC })).toString("base64");
  const body = { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", request_type: "call_function", account_id: "intents.near", method_name: "mt_balance_of", args_base64: args } };
  const res = await fetch(NEAR_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const bytes = ((await res.json()) as { result?: { result?: number[] } }).result?.result;
  if (!bytes) stop("could not read the Intents balance");
  return BigInt(JSON.parse(Buffer.from(bytes as number[]).toString()) as string);
}
async function baseBalance(): Promise<bigint> {
  const data = "0x70a08231" + RECIPIENT.slice(2).toLowerCase().padStart(64, "0");
  const res = await fetch(BASE_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_BASE_CONTRACT, data }, "latest"] }), signal: AbortSignal.timeout(30_000) });
  const result = ((await res.json()) as { result?: string }).result;
  if (!result) stop("could not read the Base balance");
  return BigInt(result as string);
}
async function balances() {
  return { at: new Date().toISOString(), intents: (await intentsBalance()).toString(), base: (await baseBalance()).toString() };
}
/** Read-only calls retry a network failure. A submit never does: it could pay twice (rule 3). */
async function api(method: "GET" | "POST", path: string, body?: unknown) {
  const retries = path.startsWith("/submit-intent") ? 1 : 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await apiOnce(method, path, body);
    } catch (err) {
      if (attempt >= retries) throw err;
      log(`  network error on ${path}, retry ${attempt}`);
      await sleep(10_000);
    }
  }
}
async function apiOnce(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, { method, headers: { "Content-Type": "application/json", "X-API-Key": JWT }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON is kept verbatim.
  }
  return { at: new Date().toISOString(), path, request: body ?? null, status: res.status, body: parsed as any };
}
const quoteBody = (dry: boolean, deadline: Date) => ({
  dry,
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 100,
  originAsset: USDC,
  depositType: "INTENTS",
  destinationAsset: USDC_BASE,
  amount: PAYOUT,
  recipient: RECIPIENT,
  recipientType: "DESTINATION_CHAIN",
  refundTo: TREASURY,
  refundType: "INTENTS",
  deadline: deadline.toISOString(),
});
const status = (depositAddress: string) => api("GET", `/status?depositAddress=${encodeURIComponent(depositAddress)}`);

// RESUME=1 continues after step 1, from the recorded start balances and quote.
const RESUME = process.env.RESUME === "1";
const recorded = (name: string) => JSON.parse(readFileSync(new URL(`../results/S-E-${name}.json`, import.meta.url), "utf8"));
const start = RESUME ? recorded("balances-start") : await balances();
if (!RESUME) record("S-E", "balances-start", start);
log(`Start: Intents ${start.intents}; Base ${start.base}`);
const startIntents = BigInt(start.intents);
const startBase = BigInt(start.base);
if (startIntents < CAP) stop("the public Intents balance is below the spike cap");

async function checkMovement(expectedMaxSpent: bigint, label: string) {
  const now = await balances();
  const spent = startIntents - BigInt(now.intents);
  log(`${label}: Intents ${now.intents} (spent ${spent}); Base ${now.base} (+${BigInt(now.base) - startBase})`);
  if (spent > CAP) stop(`CAP BREACHED: spent ${spent}`);
  if (spent > expectedMaxSpent) stop(`UNEXPECTED MOVEMENT at ${label}: spent ${spent}, expected at most ${expectedMaxSpent}`);
  return { now, spent };
}

/** Signs only a single USDC transfer to the expected deposit address, within the remaining cap. */
async function signChecked(payload: { message: string; nonce: string; recipient: string }, depositAddress: string, alreadySpent: bigint) {
  const message = JSON.parse(payload.message) as { signer_id: string; intents: { intent: string; receiver_id?: string; tokens?: Record<string, string> }[] };
  const item = message.intents[0];
  if (message.signer_id !== TREASURY || message.intents.length !== 1 || item?.intent !== "transfer" || item.receiver_id !== depositAddress) stop("the generated intent isn't the expected transfer");
  const entries = Object.entries(item?.tokens ?? {});
  if (entries.length !== 1 || entries[0]?.[0] !== USDC) stop("the generated intent spends something else");
  const debit = BigInt(entries[0]?.[1] as string);
  if (alreadySpent + debit > CAP) stop(`signing ${debit} would break the cap`);
  const signed = await new KeyPairSigner(keyPair).signNep413Message(TREASURY, { message: payload.message, nonce: new Uint8Array(Buffer.from(payload.nonce, "base64")), recipient: payload.recipient });
  return { debit, signedData: { standard: "nep413", payload, public_key: signed.publicKey.toString(), signature: "ed25519:" + baseEncode(signed.signature) } };
}
async function pollTerminal(depositAddress: string, minutes: number) {
  const seen: { at: string; status: unknown }[] = [];
  const until = Date.now() + minutes * 60_000;
  let last: any;
  while (Date.now() < until) {
    last = await status(depositAddress);
    const s = last.body?.status;
    if (seen.at(-1)?.status !== s) {
      seen.push({ at: last.at, status: s ?? `HTTP ${last.status}` });
      log(`  status: ${s ?? `HTTP ${last.status}`}`);
    }
    if (TERMINAL.has(s)) break;
    await sleep(5_000);
  }
  return { seen, last };
}

let requestedDeadline: Date;
let expiredAddress: string;
let replaySource: { signedData: unknown; depositAddress: string } | undefined;
let spent = 0n;
let step1Submitted: unknown = null;
if (RESUME) {
  const q = recorded("1-live-quote");
  requestedDeadline = new Date(q.request.deadline);
  expiredAddress = q.body.quote.depositAddress;
  spent = (await checkMovement(0n, "on resume")).spent;
  log(`Resuming: the run stopped on a DNS failure after step 1, which signed nothing.`);
} else {
// --- Step 1: the shortest deadline the API accepts. None is documented, so probe with dry quotes. ---
const probes: unknown[] = [];
let deadlineSeconds = 0;
for (const seconds of [10, 30, 60, 120, 180]) {
  const dry = await api("POST", "/quote", quoteBody(true, new Date(Date.now() + seconds * 1000)));
  probes.push({ seconds, status: dry.status, message: dry.body?.message ?? null });
  log(`Dry probe ${seconds}s: HTTP ${dry.status} ${dry.body?.message ?? "accepted"}`);
  if (dry.status < 300) {
    deadlineSeconds = seconds;
    break;
  }
}
record("S-E", "1-deadline-probes", { probes, deadlineSeconds });
if (!deadlineSeconds) stop("no probed deadline was accepted");

requestedDeadline = new Date(Date.now() + deadlineSeconds * 1000);
const live = await api("POST", "/quote", quoteBody(false, requestedDeadline));
record("S-E", "1-live-quote", live);
log(`Live quote: HTTP ${live.status}; requested deadline ${requestedDeadline.toISOString()}; response deadline ${live.body?.quote?.deadline}; timeWhenInactive ${live.body?.quote?.timeWhenInactive}; amountIn ${live.body?.quote?.amountIn}; ${live.body?.message ?? ""}`);
expiredAddress = live.body?.quote?.depositAddress ?? stop("the live quote returned no deposit address");

const wait = requestedDeadline.getTime() + 2_000 - Date.now();
if (wait > 0) await sleep(wait);
const statusAfterDeadline = await status(expiredAddress);
record("S-E", "3-status-immediately-after-deadline", statusAfterDeadline);
log(`Status right after the deadline: HTTP ${statusAfterDeadline.status} ${statusAfterDeadline.body?.status ?? statusAfterDeadline.body?.message}`);

const generated = await api("POST", "/generate-intent", { type: "swap_transfer", standard: "nep413", signerId: TREASURY, depositAddress: expiredAddress });
record("S-E", "1-generate-after-deadline", generated);
log(`Generate after the deadline: HTTP ${generated.status} ${generated.body?.message ?? "payload returned"}`);

spent = (await checkMovement(0n, "after generate")).spent;
if (generated.status < 300 && generated.body?.intent) {
  const { signedData, debit } = await signChecked(generated.body.intent.payload, expiredAddress, spent);
  const submit = await api("POST", "/submit-intent", { type: "swap_transfer", signedData });
  step1Submitted = submit;
  record("S-E", "1-submit-after-deadline", submit);
  log(`Submit after the deadline: HTTP ${submit.status} ${submit.body?.intentHash ?? submit.body?.message}`);
  if (submit.status < 300) {
    const polled = await pollTerminal(expiredAddress, 10);
    record("S-E", "1-status-after-submit", polled);
    log(`Expired quote final status: ${polled.last?.body?.status}`);
    if (polled.last?.body?.status === "SUCCESS") replaySource = { signedData, depositAddress: expiredAddress };
  }
  spent = (await checkMovement(debit, "after the expired quote's submit")).spent;
} else {
  log("No payload returned after the deadline, so nothing was signed.");
}

}

// --- Step 3: the never-funded quote's status, 5 minutes after the deadline. ---
const fiveMinutes = requestedDeadline.getTime() + 5 * 60_000 + 2_000 - Date.now();
if (fiveMinutes > 0) await sleep(fiveMinutes);
const statusLater = await status(expiredAddress);
record("S-E", "3-status-five-minutes-after-deadline", { ...statusLater, minutesAfterDeadline: (Date.parse(statusLater.at) - requestedDeadline.getTime()) / 60_000 });
log(`Status 5 minutes after the deadline: HTTP ${statusLater.status} ${statusLater.body?.status ?? statusLater.body?.message}`);

// --- Step 2: replay. ---
if (!replaySource) {
  log("Step 1 didn't pay, so making one fresh payout to replay.");
  const quote = await api("POST", "/quote", quoteBody(false, new Date(Date.now() + 10 * 60_000)));
  record("S-E", "2-fresh-quote", quote);
  const address: string = quote.body?.quote?.depositAddress ?? stop("the fresh quote returned no deposit address");
  const gen = await api("POST", "/generate-intent", { type: "swap_transfer", standard: "nep413", signerId: TREASURY, depositAddress: address });
  record("S-E", "2-fresh-generate", gen);
  if (!gen.body?.intent) stop("the fresh generate failed");
  const { signedData, debit } = await signChecked(gen.body.intent.payload, address, spent);
  const submit = await api("POST", "/submit-intent", { type: "swap_transfer", signedData });
  record("S-E", "2-fresh-submit", submit);
  log(`Fresh submit: HTTP ${submit.status} ${submit.body?.intentHash ?? submit.body?.message}`);
  if (submit.status >= 300) stop("the fresh submit failed");
  const polled = await pollTerminal(address, 15);
  record("S-E", "2-fresh-status", polled);
  if (polled.last?.body?.status !== "SUCCESS") stop(`the fresh payout ended ${polled.last?.body?.status}`);
  replaySource = { signedData, depositAddress: address };
  spent = (await checkMovement(spent + debit, "after the fresh payout")).spent;
}
await sleep(60_000); // Let any refund of the slippage buffer land first.
const beforeReplay = await balances();
record("S-E", "2-balances-before-replay", beforeReplay);
log(`Before replay: Intents ${beforeReplay.intents}; Base ${beforeReplay.base}`);

const replay = await api("POST", "/submit-intent", { type: "swap_transfer", signedData: replaySource.signedData });
record("S-E", "2-replay-submit", replay);
log(`Replay submit: HTTP ${replay.status} ${replay.body?.intentHash ?? ""} ${replay.body?.message ?? ""}`);
const replayStatus: unknown[] = [];
for (let i = 0; i < 6; i += 1) {
  await sleep(30_000);
  const s = await status(replaySource.depositAddress);
  replayStatus.push({ at: s.at, status: s.body?.status, http: s.status });
  const now = await balances();
  log(`  after replay +${(i + 1) * 30}s: status ${s.body?.status}; Intents ${now.intents}; Base ${now.base}`);
  if (BigInt(now.intents) < BigInt(beforeReplay.intents) || BigInt(now.base) > BigInt(beforeReplay.base)) {
    record("S-E", "2-replay-status", { replayStatus, now });
    stop("UNEXPECTED MOVEMENT AFTER REPLAY");
  }
}
record("S-E", "2-replay-status", { replayStatus });

const end = await balances();
record("S-E", "balances-end", { start, end, step1Submitted: Boolean(step1Submitted) });
log(`End: Intents ${end.intents}; Base ${end.base}; total left the public balance ${startIntents - BigInt(end.intents)} (cap ${CAP})`);
log("DONE");
