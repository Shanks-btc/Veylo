// Envelope encryption (L30, L31, ARCHITECTURE §5). A per-org data key, wrapped by a master key:
// SESSION_ENCRYPTION_KEY in the API, AGENT_KEY_MASTER_KEY in the worker.
// Associated data binds every ciphertext to its org, purpose and record, so one copied to another
// row or org fails to decrypt.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

const NONCE_BYTES = 24;
const KEY_BYTES = 32;
const VERSION = "v1";

export type SecretBinding = {
  readonly orgId: string;
  readonly purpose: string;
  readonly recordId: string;
};

export class SecretError extends Error {
  constructor() {
    // Deliberately says nothing about the key, the ciphertext or the binding.
    super("could not decrypt secret");
    this.name = "SecretError";
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
/** JSON, so a separator inside one field can't shift bytes into another. */
const aad = (parts: readonly string[]) => utf8(JSON.stringify(parts));

function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, data: Uint8Array) {
  const ciphertext = xchacha20poly1305(key, nonce, data).encrypt(plaintext);
  return `${VERSION}.${b64(nonce)}.${b64(ciphertext)}`;
}

function open(key: Uint8Array, sealed: string, data: Uint8Array): Uint8Array {
  try {
    const [version, nonce, ciphertext] = sealed.split(".");
    if (version !== VERSION || !nonce || !ciphertext) throw new SecretError();
    return xchacha20poly1305(key, Buffer.from(nonce, "base64"), data).decrypt(
      Buffer.from(ciphertext, "base64"),
    );
  } catch {
    throw new SecretError();
  }
}

export type SecretBox = ReturnType<typeof createSecretBox>;

export function createSecretBox(options: {
  /** 32 bytes, base64 encoded. */
  masterKey: string;
  random: (bytes: number) => Uint8Array;
}) {
  const master = Buffer.from(options.masterKey, "base64");
  if (master.length !== KEY_BYTES) throw new RangeError("the master key must be 32 bytes");
  const wrapData = (orgId: string) => aad([VERSION, "data-key", orgId]);

  return {
    /** A new data key for an org, wrapped. Store the result; the raw key never leaves this module. */
    newWrappedDataKey(orgId: string): string {
      return seal(master, options.random(NONCE_BYTES), options.random(KEY_BYTES), wrapData(orgId));
    },
    encrypt(wrappedKey: string, binding: SecretBinding, plaintext: string): string {
      const key = open(master, wrappedKey, wrapData(binding.orgId));
      return seal(
        key,
        options.random(NONCE_BYTES),
        utf8(plaintext),
        aad([VERSION, binding.orgId, binding.purpose, binding.recordId]),
      );
    },
    decrypt(wrappedKey: string, binding: SecretBinding, sealed: string): string {
      const key = open(master, wrappedKey, wrapData(binding.orgId));
      const bytes = open(
        key,
        sealed,
        aad([VERSION, binding.orgId, binding.purpose, binding.recordId]),
      );
      return new TextDecoder().decode(bytes);
    },
  };
}
