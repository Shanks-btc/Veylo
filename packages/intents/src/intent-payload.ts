import { base58, base64 } from "@scure/base";
import { z } from "zod";
import type { Nep413SignedData } from "./oneclick-treasury.js";

// The versioned nonce layout, as recorded in T5c and T6 and required by the 1Click auth docs:
// magic (4), version (1), salt (4), deadline in ns (8, little-endian), start time in ns (8) + random (7).
const MAGIC = [0x56, 0x28, 0xf6, 0xc6];
const VERSION = 0;
const NS_PER_MS = 1_000_000n;

/** The salt is read from the verifier at runtime and never hardcoded (L12). */
export function encodeVersionedNonce(input: {
  saltHex: string;
  deadline: Date;
  start: Date;
  random: Uint8Array;
}): string {
  const salt = Buffer.from(input.saltHex, "hex");
  if (salt.length !== 4) throw new RangeError("the salt must be 4 bytes");
  if (input.random.length !== 7) throw new RangeError("the random part must be 7 bytes");
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out.set(salt, 5);
  view.setBigUint64(9, BigInt(input.deadline.getTime()) * NS_PER_MS, true);
  view.setBigUint64(17, BigInt(input.start.getTime()) * NS_PER_MS, true);
  out.set(input.random, 25);
  return base64.encode(out);
}

export function nonceSaltHex(nonce: string): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(nonce);
  } catch {
    return undefined;
  }
  if (bytes.length !== 32 || MAGIC.some((b, i) => bytes[i] !== b) || bytes[4] !== VERSION) {
    return undefined;
  }
  return Buffer.from(bytes.slice(5, 9)).toString("hex");
}

/** Wallet output (base64) to what 1Click takes (ed25519:base58), as proven in S-A and S-A2. */
export function toSignedData(
  payload: { message: string; nonce: string; recipient: string },
  wallet: { publicKey: string; signature: string },
): Nep413SignedData {
  return {
    standard: "nep413",
    payload,
    public_key: wallet.publicKey,
    signature: `ed25519:${base58.encode(base64.decode(wallet.signature))}`,
  };
}

/** The "empty intent" that proves account ownership. It moves nothing. */
export function sessionMessage(signerId: string, deadline: Date): string {
  return JSON.stringify({ deadline: deadline.toISOString(), intents: [], signer_id: signerId });
}

const transferMessage = z
  .object({
    deadline: z.string(),
    intents: z
      .array(
        z
          .object({
            intent: z.literal("transfer"),
            receiver_id: z.string(),
            tokens: z.record(z.string(), z.string()),
          })
          .strict(),
      )
      .length(1),
    signer_id: z.string(),
  })
  .strict();

/**
 * 1Click wrote this payload, and the treasury is about to sign it, so it's checked rather than
 * trusted: one transfer, of exactly the quoted token and amount, to the quote's deposit address.
 */
export function shieldPayloadProblem(
  payload: { message: string; nonce: string; recipient: string },
  expected: {
    signerId: string;
    depositAddress: string;
    tokenId: string;
    amount: string;
    verifier: string;
    saltHex: string;
  },
): string | undefined {
  if (payload.recipient !== expected.verifier) return "wrong verifier";
  if (nonceSaltHex(payload.nonce) !== expected.saltHex) return "wrong nonce or salt";
  let json: unknown;
  try {
    json = JSON.parse(payload.message);
  } catch {
    return "message is not JSON";
  }
  const parsed = transferMessage.safeParse(json);
  if (!parsed.success) return "not a single transfer";
  const { signer_id, intents } = parsed.data;
  if (signer_id !== expected.signerId) return "wrong signer";
  const transfer = intents[0];
  if (transfer?.receiver_id !== expected.depositAddress) return "wrong receiver";
  const entries = Object.entries(transfer.tokens);
  if (entries.length !== 1 || entries[0]?.[0] !== expected.tokenId) return "wrong token";
  if (entries[0]?.[1] !== expected.amount) return "wrong amount";
  return undefined;
}
