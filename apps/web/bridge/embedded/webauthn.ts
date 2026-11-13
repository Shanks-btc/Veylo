// Passkeys for the Veylo wallet (slice W6), through the WebAuthn PRF extension: the authenticator
// returns 32 secret bytes that depend on the credential and on the salt we send, and that never
// leave the device unless the page asks for them. Those bytes (not the passkey's signature) become
// the key that encrypts the wallet. PRF support differs by browser and authenticator, so every use
// is detected at run time and a wallet falls back to a password where PRF is missing.
//
// Everything goes through the injectable `credentials` object so tests can drive it without a
// browser, and a virtual authenticator (with PRF) drives it in the browser check.
import { base64url } from "@scure/base";

export class PrfUnsupported extends Error {
  constructor() {
    super("This device can't use a passkey to protect a wallet.");
    this.name = "PrfUnsupported";
  }
}

export type Passkeys = {
  /** Makes a passkey and returns its PRF output for `prfSalt`, or throws PrfUnsupported. */
  create(input: {
    rpId: string;
    userId: Uint8Array;
    userName: string;
    prfSalt: Uint8Array;
    random: (bytes: number) => Uint8Array;
  }): Promise<{ credentialId: string; prfOutput: Uint8Array }>;
  /** Asks the person to use the passkey and returns its PRF output for `prfSalt`. */
  get(input: {
    rpId: string;
    credentialId: string;
    prfSalt: Uint8Array;
    random: (bytes: number) => Uint8Array;
  }): Promise<Uint8Array>;
};

type PrfResults = { enabled?: boolean; results?: { first?: ArrayBuffer } };
const prfOf = (cred: PublicKeyCredential): PrfResults | undefined =>
  (cred.getClientExtensionResults() as { prf?: PrfResults }).prf;

function firstOutput(prf: PrfResults | undefined): Uint8Array | undefined {
  const first = prf?.results?.first;
  if (!first) return undefined;
  const out = new Uint8Array(first);
  return out.length === 32 ? out : undefined;
}

export function browserPasskeys(
  credentials: CredentialsContainer | undefined = globalThis.navigator?.credentials,
): Passkeys {
  async function get(input: Parameters<Passkeys["get"]>[0]): Promise<Uint8Array> {
    if (!credentials) throw new PrfUnsupported();
    const cred = (await credentials.get({
      publicKey: {
        challenge: input.random(32) as BufferSource,
        rpId: input.rpId,
        allowCredentials: [
          { type: "public-key", id: base64url.decode(input.credentialId) as BufferSource },
        ],
        userVerification: "required",
        extensions: { prf: { eval: { first: input.prfSalt as BufferSource } } } as never,
      },
    })) as PublicKeyCredential | null;
    const out = cred ? firstOutput(prfOf(cred)) : undefined;
    if (!out) throw new PrfUnsupported();
    return out;
  }
  return {
    get,
    async create(input) {
      if (!credentials) throw new PrfUnsupported();
      const cred = (await credentials.create({
        publicKey: {
          rp: { id: input.rpId, name: "Veylo wallet" },
          user: {
            id: input.userId as BufferSource,
            name: input.userName,
            displayName: input.userName,
          },
          challenge: input.random(32) as BufferSource,
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
          extensions: { prf: { eval: { first: input.prfSalt as BufferSource } } } as never,
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw new PrfUnsupported();
      const prf = prfOf(cred);
      const credentialId = base64url.encode(new Uint8Array(cred.rawId));
      // Some authenticators only give the PRF output on use, not on creation.
      const out = firstOutput(prf);
      if (out) return { credentialId, prfOutput: out };
      if (prf?.enabled !== true) throw new PrfUnsupported();
      return {
        credentialId,
        prfOutput: await get({
          rpId: input.rpId,
          credentialId,
          prfSalt: input.prfSalt,
          random: input.random,
        }),
      };
    },
  };
}
