// Types for wallets-doc-lib.mjs: docs/WALLETS.md rendered from the wallet lock and its review.
export declare function renderWalletsDoc(
  lock: {
    manifest: { url: string; version: string; fetchedAt: string };
    wallets: readonly {
      id: string;
      name: string;
      kind: string;
      version: string;
      enabled: boolean;
      reason: string;
      executor: { sha256: string; file: string; bytes: number };
      nep413: { signMessage: number; nonce: number; recipient: number };
      hosts: readonly {
        origin: string;
        verdict: string;
        line: number;
        col: number;
        note: string;
      }[];
    }[];
  },
  review: { wallets: Record<string, { reason?: string }> },
): string;
