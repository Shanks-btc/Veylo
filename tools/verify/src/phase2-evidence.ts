// Phase 2 mainnet transactions, copied as data from verification/results (L5): hashes, amounts,
// routes and dates only. No signature, key or token. The EVM recipient is the dev recipient wallet,
// and the funding deposit address is 1Click's. Nothing identifies the founder's personal wallet.

export type Phase2Row = {
  date: string;
  event: string;
  chain: "near" | "base" | "arb" | "bsc" | "sol";
  tx: string;
  /** NEAR: the account used to look the transaction up. EVM: the token's expected recipient. */
  party: string;
  /** EVM only: what the transfer log must show, in the token's smallest units. */
  amount?: { units: bigint; symbol: "USDC" | "USDT"; decimals: 6 | 18 };
  source: string;
};

const EVM_RECIPIENT = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
const usdc = (units: bigint) => ({ units, symbol: "USDC" as const, decimals: 6 as const });
const near = (date: string, event: string, tx: string, source: string): Phase2Row => ({
  date,
  event,
  chain: "near",
  tx,
  party: "intents.near",
  source,
});

export const PHASE2_ROWS: readonly Phase2Row[] = [
  {
    date: "2026-11-05T15:17:57Z",
    event: "T5 funding: 2 USDT sent on BSC to the 1Click deposit address (sender redacted)",
    chain: "bsc",
    tx: "0x3b38538e3ca9f818dc451bfb99627ecb404d4030566c090b6385cc09d9e7c711",
    party: "0x11d0411de9b6c725D94aF2d24fC6A6cF4F11bE84",
    amount: { units: 2000000000000000000n, symbol: "USDT", decimals: 18 },
    source: "T5-fund-origin-tx.json, T5-fund-status.json",
  },
  ...[
    "3B8V2cG6XwH9xG9Cv9kbk8hAYanUGgxAPhu8vYn8tH5q",
    "D7cPck5NmRjhv53xNUvQHxyVwfpELBP1WFAtrWFGgSWH",
    "EBtZPfxHkq3ZY59rtb6ATZU2juf1d7epgsuBBksUcmmX",
    "2cJrzde29v8XgjNR7Dp9mCXfECN8rER23BpGdm7Qi3NW",
  ].map((tx) =>
    near(
      "2026-11-05T15:19:11Z",
      "T5 funding: settled into the treasury's Intents balance",
      tx,
      "T5-fund-status.json",
    ),
  ),
  ...[
    "7Mm6ctWXUEdAFFfbZuH8V4NNpKeggfTrQxRf1vkBKgx",
    "12CP8DF7umwF617kdrWuk8B8rixDH8FqLpmKqfqVCZWT",
    "8rWKiadsk1Uny37EWD8UimxLcp9rPhy2TJmmKMpYGpsc",
    "2M4rSw8wZCkSrwbovvewLLYjTncZbfN5CJLtK2KG4WPb",
  ].map((tx) =>
    near(
      "2026-11-05T15:28:07Z",
      "T5 C2: 0.5 USDC payout to Base, NEAR side",
      tx,
      "T5-c2-status.json",
    ),
  ),
  {
    date: "2026-11-05T15:28:07Z",
    event: "T5 C2: 0.5 USDC payout delivered on Base",
    chain: "base",
    tx: "0xb8f7cd70174d9c3a951f137d1de7b76e4dcfdffd1fc11c78dc290b1fc0fb4aa8",
    party: EVM_RECIPIENT,
    amount: usdc(500000n),
    source: "T5-c2-status.json",
  },
  ...[
    "7AV41N5upRz5ufeYY9XBaAWMXQsHb5dE6r1B3HJdCtmL",
    "vSHBjBKSxEEaM8fpZDbXfixFop2uwXPBuNRwgHuKWdw",
    "293nTg3diCArYT3dfvg11GerAcCuo47ZeYgtFtJ6CRee",
  ].map((tx) =>
    near(
      "2026-11-05T15:33:53Z",
      "T5 batch: 0.1 USDC payout to Base, NEAR side",
      tx,
      "T5-batch-status-base.json",
    ),
  ),
  {
    date: "2026-11-05T15:33:53Z",
    event: "T5 batch: 0.1 USDC payout delivered on Base",
    chain: "base",
    tx: "0x2480e40d66dc065a86156c81fc97a7a6c48ed51b3cde249be78760976fb8dc48",
    party: EVM_RECIPIENT,
    amount: usdc(100000n),
    source: "T5-batch-status-base.json",
  },
  ...[
    "2dMEk2bWQW5gW4auTuzU1GJYNzadQoz5BjdmMsPNa2VD",
    "8NPsM1sJMbxF5KK6goFjdfxAR7NKPK2ZNyq8B97UhUrm",
    "ZFrtojReATNQCLGscaJKDTKP7zcQZpjsVc1Hgwy8P6e",
    "5t4vgegfuD2Lbs1zzWuPWYi3ZRtQN9xps8FDvkTmzEnC",
  ].map((tx) =>
    near(
      "2026-11-05T15:33:56Z",
      "T5 batch: 0.1 USDC payout to Arbitrum, NEAR side",
      tx,
      "T5-batch-status-arb.json",
    ),
  ),
  {
    date: "2026-11-05T15:33:56Z",
    event: "T5 batch: 0.1 USDC payout delivered on Arbitrum",
    chain: "arb",
    tx: "0x124cbe812cf6d5d2a12ae91fa92f09a1c9d6d3c19f783b5be292d849347fdc4e",
    party: EVM_RECIPIENT,
    amount: usdc(100000n),
    source: "T5-batch-status-arb.json",
  },
  near(
    "2026-11-05T15:58:09Z",
    "T5b shield: 0.3 USDC from the public to the confidential balance",
    "C64k4KcjyS5AoiBZB2B1XDHe42uK8aqJXpQ1LNzt6ff8",
    "T5b-T6-partial.md, T5b-privacy.md",
  ),
  ...[
    "4cSR3khugpY9ga2hrZyEp2yG65X8wobJt8Ftd92dvTNa",
    "NYxGcFad7j7X1hxGZDzhFNNd8QQJRVvyrtsaNTVTqep",
  ].map((tx) =>
    near(
      "2026-11-05T17:31:15Z",
      "T5b: 0.1 USDC confidential payout to Base, NEAR side",
      tx,
      "T5b-payout-status.json",
    ),
  ),
  {
    date: "2026-11-05T17:31:15Z",
    event: "T5b: 0.1 USDC confidential payout delivered on Base",
    chain: "base",
    tx: "0x4bf4fa942cecd5e031288d33153698a84919cfb3b18bbb3c1423376bd39fcf85",
    party: EVM_RECIPIENT,
    amount: usdc(100000n),
    source: "T5b-payout-status.json",
  },
  ...[
    "ArRaKrXJvPKzC3A29VN6BXyfQ72P4yuSd4XS5TEbJBhG",
    "AJSs53SsTsgKAnsdSPceYF6VYjU5nX5Zeu58GtFUTrZp",
  ].map((tx) =>
    near(
      "2026-11-05T17:47:31Z",
      "T5d: 0.03 USDC cash-out to Base, NEAR side",
      tx,
      "T5d-status.json",
    ),
  ),
  {
    date: "2026-11-05T17:47:31Z",
    event: "T5d: 0.03 USDC cash-out delivered on Base",
    chain: "base",
    tx: "0xc642e2c5f6cd910254a87f55b2d8c4000c8e8304d7bfdff4455b91d86a1506d0",
    party: EVM_RECIPIENT,
    amount: usdc(30000n),
    source: "T5d-status.json",
  },
  ...[
    "4tRXrAsn79Q8mo4SEkqaErcihe2Ky8Y2mfLmSkkucnEu",
    "M2SvwpGWE8xPSVgbPPAmGpyJtKzCfUPZhxzpq7dYieS",
    "Fcvx8chEK7cXN5p82aDg5aXH3Qsq46iFwtKrouHDXCtq",
    "4sj9PAJ4f769UnvQSVAXYfR8Liy47bnYZBLjeE8KwFAx",
  ].map((tx) =>
    near(
      "2026-11-07T09:23:40Z",
      "S-E: 0.05 USDC payout to Base, NEAR side",
      tx,
      "S-E-2-fresh-status.json",
    ),
  ),
  {
    date: "2026-11-07T09:23:40Z",
    event: "S-E: 0.05 USDC payout delivered on Base",
    chain: "base",
    tx: "0xd164bb433ae9dfa0401dcba6ee1c850bd011e75a80d9d59fce381951fdc4b6d2",
    party: EVM_RECIPIENT,
    amount: usdc(50000n),
    source: "S-E-2-fresh-status.json",
  },
];

/** Recorded, but with no public transaction to re-check. Listed so nothing is silently left out. */
export const PHASE2_NOTES = [
  "T5c (2026-11-05T17:42:01Z): 0.05 USDC private receipt, confidential balance to confidential balance. 1Click reported SUCCESS with no public transaction, which is the point of a private receipt (T5c.md, T5c-status.json).",
] as const;
