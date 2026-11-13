/** What the app needs from a wallet. The near-connect adapter implements it; tests use doubles. */
export type WalletSigner = {
  /**
   * Connects and returns the one account the wallet offers (deduplicated, §15 rule 3), with the
   * public key it will sign with when the wallet reports one. Gate B2 checks that key before any
   * payout signature, and a missing key fails B2 closed.
   */
  connect(intent?: "create" | "restore"): Promise<{ accountId: string; publicKey?: string }>;
  /** NEP-413: the wallet's base64 signature and `ed25519:` public key, as proven in S-A2. */
  signMessage(input: { message: string; recipient: string; nonce: Uint8Array }): Promise<{
    accountId: string;
    publicKey: string;
    signature: string;
  }>;
  disconnect(): Promise<void>;
  /** The Veylo wallet only: show the recovery phrase again, or add a second passkey. */
  manage?(action: "export" | "addPasskey"): Promise<{ accountId: string }>;
};
