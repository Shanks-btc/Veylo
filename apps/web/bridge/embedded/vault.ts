// How the Veylo wallet's key is kept (slice W6): encrypted with AES-256-GCM under a key that comes
// from either a passkey (the WebAuthn PRF extension) or a wallet password through Argon2id. Only the
// encrypted key is ever stored. The associated data binds each ciphertext to this account, this
// public key and the way it was protected, so a blob can't be moved to another account or presented
// as another kind of protection, and any change to the bytes makes decryption fail.
//
// The wallet password is a different secret from the email password: it is used only here, in the
// wallet bridge origin, and never sent anywhere. Argon2id parameters: 19 MiB, 3 passes, 1 lane
// (above the OWASP minimum of 19 MiB and 2 passes), salted with 16 random bytes per wrap.
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";
import { keyFromEntropy } from "./derive";

export const KDF_PARAMS = { t: 3, m: 19_456, p: 1 } as const;

export type PasswordWrap = {
  kind: "password";
  kdf: { alg: "argon2id"; t: number; m: number; p: number; salt: string };
  iv: string;
  ct: string;
};
export type PasskeyWrap = {
  kind: "passkey";
  credentialId: string;
  prfSalt: string;
  rpId: string;
  iv: string;
  ct: string;
};
export type Wrap = PasswordWrap | PasskeyWrap;
export type VaultBlob = { v: 1; accountId: string; publicKey: string; wraps: Wrap[] };

const enc = new TextEncoder();
type Random = (bytes: number) => Uint8Array;
const subtle = () => globalThis.crypto.subtle;
const b64 = (data: Uint8Array) => base64.encode(data);
const unb64 = (text: string) => base64.decode(text);
const aad = (accountId: string, publicKey: string, kind: string) =>
  enc.encode(`veylo-wallet/v1|${accountId}|${publicKey}|${kind}`);

async function aesKey(ikm: Uint8Array): Promise<CryptoKey> {
  const raw = hkdf(sha256, ikm, undefined, enc.encode("veylo-wallet/v1/aes-256-gcm"), 32);
  return subtle().importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(ikm: Uint8Array, entropy: Uint8Array, ad: Uint8Array, random: Random) {
  const iv = random(12);
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: ad as BufferSource },
    await aesKey(ikm),
    entropy as BufferSource,
  );
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function open(ikm: Uint8Array, wrap: { iv: string; ct: string }, ad: Uint8Array) {
  try {
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: unb64(wrap.iv) as BufferSource, additionalData: ad as BufferSource },
      await aesKey(ikm),
      unb64(wrap.ct) as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    throw new Error("That did not unlock the wallet. Check it and try again.");
  }
}

async function passwordIkm(password: string, kdf: PasswordWrap["kdf"]): Promise<Uint8Array> {
  return argon2idAsync(enc.encode(password.normalize("NFKC")), unb64(kdf.salt), {
    t: kdf.t,
    m: kdf.m,
    p: kdf.p,
    dkLen: 32,
  });
}

export async function wrapWithPassword(
  entropy: Uint8Array,
  password: string,
  random: Random,
  /** Only tests pass a cheaper cost; the screens always use KDF_PARAMS. */
  params: { t: number; m: number; p: number } = KDF_PARAMS,
): Promise<PasswordWrap> {
  const { accountId, publicKey } = keyFromEntropy(entropy);
  const kdf = { alg: "argon2id" as const, ...params, salt: b64(random(16)) };
  const sealed = await seal(
    await passwordIkm(password, kdf),
    entropy,
    aad(accountId, publicKey, "password"),
    random,
  );
  return { kind: "password", kdf, ...sealed };
}

export async function wrapWithPasskey(
  entropy: Uint8Array,
  prfOutput: Uint8Array,
  meta: { credentialId: string; prfSalt: string; rpId: string },
  random: Random,
): Promise<PasskeyWrap> {
  const { accountId, publicKey } = keyFromEntropy(entropy);
  const sealed = await seal(prfOutput, entropy, aad(accountId, publicKey, "passkey"), random);
  return { kind: "passkey", ...meta, ...sealed };
}

/** Checks that what was decrypted really is this account's key, so tampered metadata is refused. */
function checked(entropy: Uint8Array, blob: VaultBlob): Uint8Array {
  if (entropy.length !== 16 && entropy.length !== 32)
    throw new Error("That did not unlock the wallet.");
  const key = keyFromEntropy(entropy);
  if (key.accountId !== blob.accountId || key.publicKey !== blob.publicKey)
    throw new Error("That did not unlock the wallet.");
  return entropy;
}

export async function unlockWithPassword(blob: VaultBlob, wrap: PasswordWrap, password: string) {
  if (wrap.kdf.alg !== "argon2id") throw new Error("Unknown wallet format.");
  const ad = aad(blob.accountId, blob.publicKey, "password");
  return checked(await open(await passwordIkm(password, wrap.kdf), wrap, ad), blob);
}

export async function unlockWithPasskey(blob: VaultBlob, wrap: PasskeyWrap, prfOutput: Uint8Array) {
  const ad = aad(blob.accountId, blob.publicKey, "passkey");
  return checked(await open(prfOutput, wrap, ad), blob);
}

export function newVault(entropy: Uint8Array, wrap: Wrap): VaultBlob {
  const { accountId, publicKey } = keyFromEntropy(entropy);
  return { v: 1, accountId, publicKey, wraps: [wrap] };
}

/** Is this an object that could be a vault blob? Anything else in storage is ignored. */
export function isVaultBlob(value: unknown): value is VaultBlob {
  const v = value as Partial<VaultBlob> | null;
  return (
    !!v &&
    v.v === 1 &&
    typeof v.accountId === "string" &&
    typeof v.publicKey === "string" &&
    Array.isArray(v.wraps) &&
    v.wraps.length > 0 &&
    v.wraps.every(
      (w) =>
        w &&
        (w.kind === "password" || w.kind === "passkey") &&
        typeof w.iv === "string" &&
        typeof w.ct === "string",
    )
  );
}
