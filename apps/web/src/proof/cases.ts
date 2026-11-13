// The recorded Phase 2 payouts the proof screen checks live (docs/EVIDENCE.md, copied as data
// only, L5): public mainnet transactions from the T5 C2 payout (direct) and the T5b confidential
// payout (private). The same dev treasury paid the same test recipient both times.
// Identifiers come from the recorded 1Click quotes (packages/intents/src/fixtures).
import type { Identifiers } from "./mentions";

export type ProofCase = {
  readonly id: string;
  readonly kind: "direct" | "private";
  readonly title: string;
  readonly evidence: string;
  readonly ids: Identifiers;
  readonly amountUnits: string;
  /** The NEAR-side transactions of the payout (EVIDENCE.md rows). */
  readonly nearTxs: readonly string[];
  readonly deliveryTx: { readonly chain: "Base"; readonly hash: string };
};

const TREASURY = "a87a0e4f93085edbe787aa4530021045f426c8fbc500a7c1dbd729dc4f8151ce";
const RECIPIENT = "0xAf780910c0E7D41430D4615A437676a87a332C8C";

export const PROOF_CASES: readonly ProofCase[] = [
  {
    id: "direct",
    kind: "direct",
    title: "Direct payout: 0.5 USDC",
    evidence: "docs/EVIDENCE.md rows 6 to 10 (T5 C2)",
    ids: {
      treasury: TREASURY,
      deposit: "8993545ee9c93a932549745951a5d80336a263a627808fbe0989091000c7f372",
      recipient: RECIPIENT,
    },
    amountUnits: "500000",
    nearTxs: [
      "12CP8DF7umwF617kdrWuk8B8rixDH8FqLpmKqfqVCZWT",
      "2M4rSw8wZCkSrwbovvewLLYjTncZbfN5CJLtK2KG4WPb",
      "7Mm6ctWXUEdAFFfbZuH8V4NNpKeggfTrQxRf1vkBKgx",
      "8rWKiadsk1Uny37EWD8UimxLcp9rPhy2TJmmKMpYGpsc",
    ],
    deliveryTx: {
      chain: "Base",
      hash: "0xb8f7cd70174d9c3a951f137d1de7b76e4dcfdffd1fc11c78dc290b1fc0fb4aa8",
    },
  },
  {
    id: "private",
    kind: "private",
    title: "Private payout: 0.1 USDC",
    evidence: "docs/EVIDENCE.md rows 21 to 23 (T5b)",
    ids: {
      treasury: TREASURY,
      deposit: "58846af3ebc655cdba9037a9bbb516c4973eb862928931511f13a5e6d1e68246",
      recipient: RECIPIENT,
    },
    amountUnits: "100000",
    nearTxs: [
      "4cSR3khugpY9ga2hrZyEp2yG65X8wobJt8Ftd92dvTNa",
      "NYxGcFad7j7X1hxGZDzhFNNd8QQJRVvyrtsaNTVTqep",
    ],
    deliveryTx: {
      chain: "Base",
      hash: "0x4bf4fa942cecd5e031288d33153698a84919cfb3b18bbb3c1423376bd39fcf85",
    },
  },
];

export const nearExplorerTx = (hash: string) => `https://nearblocks.io/txns/${hash}`;
export const baseExplorerTx = (hash: string) => `https://basescan.org/tx/${hash}`;
