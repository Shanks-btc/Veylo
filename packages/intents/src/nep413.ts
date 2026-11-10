import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";

/** 2^31 + 413. Prefixed to the payload so a signed message can't double as a NEAR transaction. */
export const NEP413_TAG = 2_147_484_061;
export const NEP413_NONCE_BYTES = 32;

export type Nep413Payload = {
  readonly message: string;
  readonly nonce: Uint8Array;
  readonly recipient: string;
};

function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function borshString(value: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(value);
  return [u32le(bytes.length), bytes];
}

/** Borsh: tag u32, message string, nonce [u8; 32], recipient string, callbackUrl Option = None. */
export function serializeNep413(payload: Nep413Payload): Uint8Array {
  if (payload.nonce.length !== NEP413_NONCE_BYTES) {
    throw new RangeError(`nonce must be ${NEP413_NONCE_BYTES} bytes`);
  }
  const parts = [
    u32le(NEP413_TAG),
    ...borshString(payload.message),
    payload.nonce,
    ...borshString(payload.recipient),
    new Uint8Array([0]),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The 32 bytes a wallet signs. */
export const hashNep413 = (payload: Nep413Payload): Uint8Array => sha256(serializeNep413(payload));

/** Decodes `ed25519:<base58>` to 32 bytes, or returns undefined. */
export function parseEd25519PublicKey(publicKey: string): Uint8Array | undefined {
  if (!publicKey.startsWith("ed25519:")) return undefined;
  try {
    const bytes = base58.decode(publicKey.slice("ed25519:".length));
    return bytes.length === 32 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function decodeSignature(signature: string): Uint8Array | undefined {
  try {
    const bytes = base64.decode(signature);
    return bytes.length === 64 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verifies wallet output (publicKey `ed25519:<base58>`, signature base64) against a payload the
 * caller already trusts. Malformed input returns false; this never throws on bad input.
 * It proves only that the key signed. Whether the key belongs to an account is a separate check.
 */
export function verifyNep413(
  input: Nep413Payload & { readonly publicKey: string; readonly signature: string },
): boolean {
  const publicKey = parseEd25519PublicKey(input.publicKey);
  const signature = decodeSignature(input.signature);
  if (!publicKey || !signature || input.nonce.length !== NEP413_NONCE_BYTES) return false;
  try {
    return ed25519.verify(signature, hashNep413(input), publicKey, { zip215: false });
  } catch {
    return false;
  }
}
