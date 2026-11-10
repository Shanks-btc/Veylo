// Explorer links. Only domains named by each chain's official documentation, each fetched and
// confirmed 2026-11-07 (L37):
// - NEAR: nearblocks.io. https://docs.near.org/api/rpc/introduction, under "Tools":
//   "[NEAR Explorer](https://nearblocks.io)".
// - Base: basescan.org. https://docs.base.org/get-started/connect-to-base, Base Mainnet table:
//   "Block explorer | [basescan.org](https://basescan.org)".
// - Arbitrum One: arbiscan.io. https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers:
//   "[Arbiscan](https://arbiscan.io/)".
// - BNB Smart Chain: bscscan.com. https://docs.bnbchain.org/bnb-smart-chain/developers/quick-guide/:
//   "Explorer": "[BSCScan](https://bscscan.com/)".
// - NEAR Intents: explorer.near-intents.org.
//   https://docs.near-intents.org/integration/distribution-channels/1click-api/explorer/introduction.md:
//   "[NEAR Intents Explorer](https://explorer.near-intents.org/)".
// - Solana: explorer.solana.com (L38, L39). Domain: https://github.com/solana-foundation/explorer,
//   the official explorer repository, About section: "[explorer.solana.com](https://explorer.solana.com)".
//   Format /tx/<signature>: that repository's route file app/tx/[signature]/page.tsx
//   (https://api.github.com/repos/solana-foundation/explorer/contents/app/tx/%5Bsignature%5D, branch
//   master), whose page reads `signature` from its params. Both fetched live 2026-11-07, HTTP 200.
// Each builder checks the hash's form and returns undefined rather than build a link to junk.

const NEAR_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

export type ExplorerChain = "near" | "base" | "arb" | "bsc" | "sol";

export function txExplorerUrl(chain: ExplorerChain, hash: string): string | undefined {
  switch (chain) {
    case "near":
      return NEAR_HASH.test(hash) ? `https://nearblocks.io/txns/${hash}` : undefined;
    case "base":
      return EVM_HASH.test(hash) ? `https://basescan.org/tx/${hash}` : undefined;
    case "arb":
      return EVM_HASH.test(hash) ? `https://arbiscan.io/tx/${hash}` : undefined;
    case "bsc":
      return EVM_HASH.test(hash) ? `https://bscscan.com/tx/${hash}` : undefined;
    case "sol":
      return SOLANA_SIGNATURE.test(hash) ? `https://explorer.solana.com/tx/${hash}` : undefined;
    default:
      return undefined;
  }
}

/** A 1Click swap, looked up by its deposit address. */
export function intentsExplorerUrl(depositAddress: string): string | undefined {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(depositAddress)
    ? `https://explorer.near-intents.org/transactions/${encodeURIComponent(depositAddress)}`
    : undefined;
}
