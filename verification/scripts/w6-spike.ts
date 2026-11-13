// Shared helpers for the slice W6 spikes (S-F2, S-FT, S-NR, S-EW). Verification scripts only:
// nothing outside verification/ imports this. Every spike that uses these REFUSES to start unless its
// own founder-approval variable is exactly "yes" (see approve()). None has been run.
//
// Money is bigint and decimal text throughout: no floats.
import { baseEncode, KeyPair, KeyPairSigner, keyToImplicitAddress } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";

export const API = "https://1click.chaindefuser.com/v0";
export const NEAR_RPC = "https://rpc.fastnear.com";
export const USDC_NEAR_TOKEN = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_NEAR_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const WNEAR_TOKEN = "nep141:wrap.near";
export const USDT_NEAR_TOKEN = "nep141:usdt.tether-token.near";
export const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"]);
export const NAMED_ACCOUNT = /^(?=.{2,64}$)([a-z\d]+[-_])*[a-z\d]+(\.([a-z\d]+[-_])*[a-z\d]+)*\.near$/;

export function stop(reason: string): never {
  console.log(`STOPPED: ${reason}`);
  process.exit(1);
}

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) stop(`${name} is not set`);
  return value as string;
}

/** The founder's approval for one mainnet run. Anything but "yes" stops before any network call. */
export function approve(variable: string, what: string): void {
  if (process.env[variable] !== "yes") {
    stop(`${what}. Set ${variable}=yes only for the one run the founder approved.`);
  }
}

export async function api(path: string, body: Record<string, unknown>, jwt: string) {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": jwt },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON is kept verbatim as text.
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function rpc(params: Record<string, unknown>) {
  const res = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", ...params } }),
    signal: AbortSignal.timeout(30_000),
  });
  return (await res.json()) as { result?: { result?: number[]; amount?: string }; error?: unknown };
}

export async function viewText(account: string, method: string, args: Record<string, string>): Promise<string | undefined> {
  const out = await rpc({
    request_type: "call_function",
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  const bytes = out.result?.result;
  return bytes ? (JSON.parse(Buffer.from(bytes).toString()) as string) : undefined;
}

/** A treasury's balance on the NEAR Intents verifier for one token. */
export const intentsBalance = (account: string, token: string) =>
  viewText("intents.near", "mt_balance_of", { account_id: account, token_id: token });

/** An account's own NEAR balance in yoctoNEAR. */
export async function nativeBalance(account: string): Promise<string | undefined> {
  const out = await rpc({ request_type: "view_account", account_id: account });
  return out.result?.amount;
}

const DECIMAL = /^\d{1,12}(\.\d{1,12})?$/;
/** "3.43" as a bigint with 12 decimals. */
export function decimal12(text: string): bigint {
  if (!DECIMAL.test(text)) stop(`not a usable price: ${text}`);
  const [whole = "0", frac = ""] = text.split(".");
  let n = 0n;
  for (const ch of `${whole}${frac.padEnd(12, "0")}`) n = n * 10n + BigInt(ch.charCodeAt(0) - 48);
  if (n <= 0n) stop(`not a usable price: ${text}`);
  return n;
}

/** The reference price (USD per token) 1Click lists for an asset, as text. */
export async function listedPrice(jwt: string, assetId: string): Promise<string> {
  const res = await fetch(`${API}/tokens`, { headers: { "X-API-Key": jwt }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) stop(`GET /v0/tokens answered HTTP ${res.status}`);
  const tokens = (await res.json()) as { assetId: string; price?: number | string }[];
  const t = tokens.find((x) => x.assetId === assetId);
  if (t?.price === undefined) stop(`no listed price for ${assetId}`);
  return String(t?.price);
}

/** Smallest units of an 18- or 24-decimal token worth `usdMicros` (USD with 6 decimals), rounded down. */
export function unitsForUsd(usdMicros: bigint, priceText: string, decimals: number): bigint {
  return (usdMicros * 10n ** BigInt(decimals + 12 - 6)) / decimal12(priceText);
}

/** The USD value, in micro-dollars, of `units` of a token at `priceText`, rounded up (so a cap can't be slipped under). */
export function usdMicrosFor(units: bigint, priceText: string, decimals: number): bigint {
  const scale = 10n ** BigInt(decimals + 12 - 6);
  return (units * decimal12(priceText) + scale - 1n) / scale;
}

export async function pollStatus(depositAddress: string, minutes: number, log: (line: string) => void) {
  const transitions: { at: string; status: unknown; body: unknown }[] = [];
  const url = `${API}/status?depositAddress=${encodeURIComponent(depositAddress)}`;
  const until = Date.now() + minutes * 60_000;
  let last: unknown;
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const body = (await res.json()) as { status?: string };
      if (body.status !== last) {
        transitions.push({ at: new Date().toISOString(), status: body.status, body });
        last = body.status;
        log(`${new Date().toISOString()} ${String(body.status)}`);
      }
      if (body.status && TERMINAL.has(body.status)) return { terminal: true, last, transitions };
    } catch (err) {
      transitions.push({ at: new Date().toISOString(), status: "poll-error", body: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return { terminal: false, last, transitions };
}

type Quote = { depositAddress: string; amountIn: string; minAmountIn?: string; amountOut: string; minAmountOut?: string };

/** A live quote, or a stop. Never retries. */
export async function liveQuote(jwt: string, body: Record<string, unknown>): Promise<{ quote: Quote; raw: unknown }> {
  const res = await api("/quote", { dry: false, slippageTolerance: 100, ...body }, jwt);
  const parsed = res.body as { quote?: Quote };
  if (!res.ok || !parsed.quote?.depositAddress) stop(`the live quote failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return { quote: parsed.quote as Quote, raw: res.body };
}

/**
 * The treasury signs the intent 1Click generated for a quote and submits it. Nothing is signed unless
 * the intent is one signer (the treasury), the verifier `intents.near`, and spends only `token`, at
 * most `capUnits`. Same checks as S-N. Returns the intent hash.
 */
export async function signAndSubmit(input: {
  jwt: string;
  treasury: string;
  secretKey: string;
  depositAddress: string;
  token: string;
  capUnits: bigint;
}): Promise<string> {
  const keyPair = KeyPair.fromString(input.secretKey as KeyPairString);
  if (keyToImplicitAddress(keyPair.getPublicKey()) !== input.treasury) stop("the secret key does not derive the treasury account");
  const generated = await api(
    "/generate-intent",
    { type: "swap_transfer", standard: "nep413", signerId: input.treasury, depositAddress: input.depositAddress },
    input.jwt,
  );
  const intent = (generated.body as { intent?: { standard: string; payload: Record<string, string> } }).intent;
  if (!generated.ok || !intent) stop("generate-intent failed");
  const payload = (intent as { payload: Record<string, string> }).payload;
  if (Object.keys(payload).sort().join(",") !== "message,nonce,recipient") stop("unexpected payload fields");
  if (payload.recipient !== "intents.near") stop(`unexpected verifier ${payload.recipient}`);
  const nonce = Buffer.from(payload.nonce as string, "base64");
  if (nonce.length !== 32) stop("the nonce is not 32 bytes");
  const message = JSON.parse(payload.message as string) as {
    signer_id: string;
    intents: { intent: string; tokens?: Record<string, string>; diff?: Record<string, string> }[];
  };
  if (message.signer_id !== input.treasury) stop("the intent's signer is not the treasury");
  let debit = 0n;
  for (const item of message.intents) {
    const entries =
      item.intent === "transfer" ? Object.entries(item.tokens ?? {}) : item.intent === "token_diff" ? Object.entries(item.diff ?? {}) : stop(`intent type ${item.intent} cannot be checked against the cap`);
    for (const [token, amount] of entries) {
      const spent = item.intent === "transfer" ? BigInt(amount) : -BigInt(amount);
      if (spent <= 0n) continue;
      if (token !== input.token) stop(`the intent would spend another token: ${token}`);
      debit += spent;
    }
  }
  if (debit <= 0n || debit > input.capUnits) stop(`the intent debit ${debit} is outside (0, ${input.capUnits}]`);
  const toSign = { message: payload.message as string, nonce: new Uint8Array(nonce), recipient: payload.recipient as string };
  const signed = await new KeyPairSigner(keyPair).signNep413Message(input.treasury, toSign);
  const publicKey = signed.publicKey.toString();
  const signature = "ed25519:" + baseEncode(signed.signature);
  const offline = { viewAccessKey: async () => ({ permission: "FullAccess" }) } as unknown as Parameters<typeof verifyMessage>[0]["provider"];
  await verifyMessage({ signerAccountId: input.treasury, signerPublicKey: publicKey, payload: toSign, signature: signed.signature, provider: offline }).catch(() => stop("local signature verification failed"));
  const submitted = await api("/submit-intent", { type: "swap_transfer", signedData: { ...intent, public_key: publicKey, signature } }, input.jwt);
  const hash = (submitted.body as { intentHash?: string }).intentHash;
  if (!submitted.ok || !hash) stop("submit-intent failed");
  return hash as string;
}
