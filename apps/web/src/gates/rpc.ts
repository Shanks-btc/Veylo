// The gates' only network access: NEAR RPC, called straight from the browser, never through the
// Veylo API (T-2). Reuses packages/chains; nothing is reimplemented here.
import { createIntentsReader, createNearRpc, isOwnerKey } from "@veylo/chains";

export type GateRpc = {
  /** The key is a FullAccess key of the account per NEAR RPC, or derives an unfunded implicit one. */
  isAccountKey(accountId: string, publicKey: string): Promise<boolean>;
  /** has_public_key on an Intents verifier (gate B2). */
  hasPublicKey(verifier: string, accountId: string, publicKey: string): Promise<boolean>;
  /** The verifier's current salt (for the payload nonce check in gate C, L12). */
  currentSalt(verifier: string): Promise<string>;
};

export function createGateRpc(options: { url: string; fetch: typeof globalThis.fetch }): GateRpc {
  const rpc = createNearRpc(options);
  const intents = createIntentsReader(options);
  return {
    isAccountKey: (accountId, publicKey) => isOwnerKey(rpc, accountId, publicKey),
    hasPublicKey: (verifier, accountId, publicKey) =>
      intents.hasPublicKey(verifier, accountId, publicKey),
    currentSalt: (verifier) => intents.currentSalt(verifier),
  };
}
