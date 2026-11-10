// In core because hygiene rules, the API and `pnpm verify` all need it as plain domain data: no
// environment and no I/O, which is what packages/config is for.
//
// Reviewed constants copied from the T1 token list, verification/results/T1-tokens.json
// (GET /v0/tokens, 2026-11-05), and used in the T5, T5b and T5c mainnet payouts. Data only (L5).
// Tron is unsupported until tested (L25).

export type PayoutMode = "direct" | "private";
export type AddressKind = "evm" | "solana" | "near";

export type PayoutRoute = {
  readonly id: string;
  readonly label: string;
  /** The `blockchain` value in the 1Click token list. */
  readonly chain: "base" | "arb" | "sol" | "near";
  readonly assetId: string;
  readonly decimals: 6;
  readonly payoutMode: PayoutMode;
  readonly addressKind: AddressKind;
  readonly recipientType: "DESTINATION_CHAIN" | "CONFIDENTIAL_INTENTS";
};

/** USDC on NEAR: what the confidential treasury holds and pays from. */
export const TREASURY_ASSET_ID =
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export const PAYOUT_ROUTES = [
  {
    id: "usdc-base",
    label: "USDC on Base",
    chain: "base",
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    payoutMode: "direct",
    addressKind: "evm",
    recipientType: "DESTINATION_CHAIN",
  },
  {
    id: "usdc-arbitrum",
    label: "USDC on Arbitrum",
    chain: "arb",
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    decimals: 6,
    payoutMode: "direct",
    addressKind: "evm",
    recipientType: "DESTINATION_CHAIN",
  },
  {
    id: "usdc-solana",
    label: "USDC on Solana",
    chain: "sol",
    assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    decimals: 6,
    payoutMode: "direct",
    addressKind: "solana",
    recipientType: "DESTINATION_CHAIN",
  },
  {
    id: "usdc-near-confidential",
    label: "USDC confidential balance on NEAR",
    chain: "near",
    assetId: TREASURY_ASSET_ID,
    decimals: 6,
    payoutMode: "private",
    addressKind: "near",
    recipientType: "CONFIDENTIAL_INTENTS",
  },
] as const satisfies readonly PayoutRoute[];

export type PayoutRouteId = (typeof PAYOUT_ROUTES)[number]["id"];

export const PAYOUT_ROUTE_IDS = PAYOUT_ROUTES.map((r) => r.id) as [
  PayoutRouteId,
  ...PayoutRouteId[],
];

export function getPayoutRoute(id: PayoutRouteId): PayoutRoute {
  const route = PAYOUT_ROUTES.find((r) => r.id === id);
  if (!route) throw new RangeError(`unknown payout route: ${id}`);
  return route;
}

// Funding origins (L30). Reviewed constants copied from the T1 token list,
// verification/results/T1-tokens.json (GET /v0/tokens, 2026-11-05). Data only (L5).
// `verification` says how far each is proven (L32): only USDT on BSC has funded live, in T5.
export const FUNDING_ORIGINS = [
  {
    id: "usdc-base",
    symbol: "USDC",
    verification: "dry_quote_only",
    network: "Base",
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    addressKind: "evm",
  },
  {
    id: "usdc-arbitrum",
    symbol: "USDC",
    verification: "dry_quote_only",
    network: "Arbitrum",
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    decimals: 6,
    addressKind: "evm",
  },
  {
    id: "usdc-solana",
    symbol: "USDC",
    verification: "dry_quote_only",
    network: "Solana",
    assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    decimals: 6,
    addressKind: "solana",
  },
  {
    id: "usdt-bsc",
    symbol: "USDT",
    verification: "live",
    network: "BNB Smart Chain",
    assetId: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g",
    decimals: 18,
    addressKind: "evm",
  },
] as const;

export type FundingOriginId = (typeof FUNDING_ORIGINS)[number]["id"];
export const FUNDING_ORIGIN_IDS = FUNDING_ORIGINS.map((o) => o.id) as [
  FundingOriginId,
  ...FundingOriginId[],
];
export function getFundingOrigin(id: FundingOriginId) {
  const origin = FUNDING_ORIGINS.find((o) => o.id === id);
  if (!origin) throw new RangeError(`unknown funding origin: ${id}`);
  return origin;
}
