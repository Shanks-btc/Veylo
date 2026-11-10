import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58 } from "@scure/base";

export type AddressReason =
  | "evm_format"
  | "evm_bad_checksum"
  | "evm_zero_address"
  | "solana_format"
  | "solana_wrong_length"
  | "solana_system_program"
  | "near_length"
  | "near_format";

export type AddressResult<K extends string = string> =
  | { readonly ok: true; readonly kind: K; readonly normalized: string }
  | { readonly ok: false; readonly reason: AddressReason; readonly message: string };

const fail = (reason: AddressReason, message: string) => ({ ok: false, reason, message }) as const;

/** The EIP-55 form of 40 lowercase hex characters. */
function toChecksum(lowerHex: string): string {
  const hash = keccak_256(new TextEncoder().encode(lowerHex));
  let out = "0x";
  for (let i = 0; i < 40; i += 1) {
    const byte = hash[i >> 1] as number;
    const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    out += nibble >= 8 ? (lowerHex[i] as string).toUpperCase() : lowerHex[i];
  }
  return out;
}

/** Accepts all-lowercase or valid EIP-55. Normalizes to EIP-55. https://eips.ethereum.org/EIPS/eip-55 */
export function validateEvmAddress(input: string): AddressResult<"evm"> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input)) {
    return fail("evm_format", "An EVM address is 0x followed by 40 hex characters.");
  }
  const hex = input.slice(2);
  const lower = hex.toLowerCase();
  if (/^0+$/.test(lower)) return fail("evm_zero_address", "The zero address can't receive funds.");
  const checksum = toChecksum(lower);
  if (hex !== lower && input !== checksum) {
    return fail("evm_bad_checksum", "This address has mixed case with an invalid checksum.");
  }
  return { ok: true, kind: "evm", normalized: checksum };
}

export function validateSolanaAddress(input: string): AddressResult<"solana"> {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(input);
  } catch {
    return fail("solana_format", "A Solana address is base58 text.");
  }
  if (bytes.length !== 32) {
    return fail("solana_wrong_length", "A Solana address decodes to exactly 32 bytes.");
  }
  if (bytes.every((b) => b === 0)) {
    return fail("solana_system_program", "The system program address can't receive funds.");
  }
  return { ok: true, kind: "solana", normalized: input };
}

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const NEAR_IMPLICIT = /^[0-9a-f]{64}$/;

/**
 * Account ID rules: https://nomicon.io/DataStructures/Account#account-id-rules
 * Length 2 to 64. Parts of lowercase letters and digits, separated by `.`, with single `-` or `_`
 * inside a part. An implicit account is 64 lowercase hex characters.
 */
export function validateNearAccountId(
  input: string,
): AddressResult<"near_implicit" | "near_named"> {
  if (input.length < 2 || input.length > 64) {
    return fail("near_length", "A NEAR account ID is 2 to 64 characters.");
  }
  if (!NEAR_ACCOUNT.test(input)) {
    return fail(
      "near_format",
      "A NEAR account ID uses lowercase letters and digits, with single . - or _ between them.",
    );
  }
  return {
    ok: true,
    kind: NEAR_IMPLICIT.test(input) ? "near_implicit" : "near_named",
    normalized: input,
  };
}

export function validateAddress(kind: "evm" | "solana" | "near", input: string): AddressResult {
  if (kind === "evm") return validateEvmAddress(input);
  if (kind === "solana") return validateSolanaAddress(input);
  return validateNearAccountId(input);
}
