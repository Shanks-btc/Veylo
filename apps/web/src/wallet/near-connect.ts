// NEAR Connect adapter (@hot-labs/near-connect 0.12.0, pinned per §15 rule 6, as tested in S-A2).
// Each bridge page loads exactly one wallet: the manifest is self-hosted and lists only that wallet,
// with its executor served from this origin under a filename that carries its SHA-256 (§15 rule 4,
// checked by a test), so no wallet code loads from a third party at runtime and one wallet's hosts
// never widen another wallet's page (src/wallet/registry.ts, scripts/bridge-csp.mjs).
import type { WalletSigner } from "./types.js";
import { executorPath, walletById } from "./registry.js";

export async function createNearConnectWallet(options: {
  rpcUrl: string;
  walletId: string;
}): Promise<WalletSigner> {
  const entry = walletById(options.walletId);
  if (!entry || !entry.enabled) throw new Error("this wallet isn't available");
  // Loaded only in the browser: the package touches `window` when it starts.
  const { NearConnector } = await import("@hot-labs/near-connect");
  const connector = new NearConnector({
    network: "mainnet",
    providers: { mainnet: [options.rpcUrl] },
    manifest: {
      version: "veylo-1",
      wallets: [
        {
          id: entry.id,
          name: entry.name,
          icon: entry.icon || undefined,
          description: entry.description,
          website: entry.website,
          version: entry.version,
          type: entry.type,
          features: entry.features,
          platform: entry.platform,
          permissions: entry.permissions,
          executor: executorPath(entry),
        },
      ] as never,
    },
    features: { signMessage: true },
    autoConnect: false,
    footerBranding: null,
  });

  let accountId: string | undefined;
  async function wallet() {
    return connector.wallet();
  }
  return {
    async connect() {
      const w = await connector.connect({ walletId: entry.id } as never);
      const accounts = await w.getAccounts();
      const ids = [...new Set(accounts.map((a) => a.accountId))];
      if (ids.length !== 1 || !ids[0]) throw new Error("connect exactly one account");
      accountId = ids[0];
      const keys = [
        ...new Set(
          accounts
            .map((a) => (a as { publicKey?: unknown }).publicKey)
            .filter((k): k is string => typeof k === "string"),
        ),
      ];
      // One key or none: two different keys would leave B2 unsure which one signs.
      return keys.length === 1 && keys[0] ? { accountId, publicKey: keys[0] } : { accountId };
    },
    async signMessage({ message, recipient, nonce }) {
      const w = await wallet();
      const signed = await w.signMessage({ message, recipient, nonce, network: "mainnet" });
      if (accountId && signed.accountId !== accountId)
        throw new Error("the wallet signed as another account");
      return {
        accountId: signed.accountId,
        publicKey: signed.publicKey,
        signature: signed.signature,
      };
    },
    async disconnect() {
      accountId = undefined;
      await connector.disconnect();
    },
  };
}
