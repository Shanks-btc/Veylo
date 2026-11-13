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
  /** What the contractor receives: USDC, or NEAR (sized from the USD salary at quote time, W6). */
  readonly asset: "USDC" | "NEAR";
  readonly decimals: 6 | 24;
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
    asset: "USDC",
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
    asset: "USDC",
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
    asset: "USDC",
    decimals: 6,
    payoutMode: "direct",
    addressKind: "solana",
    recipientType: "DESTINATION_CHAIN",
  },
  {
    // Public USDC from the treasury's Intents balance to a NEAR account. Not proven on mainnet
    // yet: spike S-N (VERIFICATION.md). Shown as "Coming soon" until it passes (L46).
    id: "usdc-near",
    label: "USDC on NEAR",
    chain: "near",
    assetId: TREASURY_ASSET_ID,
    asset: "USDC",
    decimals: 6,
    payoutMode: "direct",
    addressKind: "near",
    recipientType: "DESTINATION_CHAIN",
  },
  {
    id: "usdc-near-confidential",
    label: "USDC confidential balance on NEAR",
    chain: "near",
    assetId: TREASURY_ASSET_ID,
    asset: "USDC",
    decimals: 6,
    payoutMode: "private",
    addressKind: "near",
    recipientType: "CONFIDENTIAL_INTENTS",
  },
  {
    // NEAR to a NEAR account, public. The contractor's salary stays in USD; the NEAR amount is
    // sized when the quote is made (EXACT_OUTPUT, so the contractor receives exactly that NEAR and
    // the treasury pays the swap fee). Not proven on mainnet yet: spike S-NR (VERIFICATION.md).
    // Confidential NEAR payouts are not documented or proven, so NEAR is direct only (L56).
    id: "near-direct",
    label: "NEAR",
    chain: "near",
    assetId: "nep141:wrap.near",
    asset: "NEAR",
    decimals: 24,
    payoutMode: "direct",
    addressKind: "near",
    recipientType: "DESTINATION_CHAIN",
  },
] as const satisfies readonly PayoutRoute[];

export type PayoutRouteId = (typeof PAYOUT_ROUTES)[number]["id"];

export const PAYOUT_ROUTE_IDS = PAYOUT_ROUTES.map((r) => r.id) as [
  PayoutRouteId,
  ...PayoutRouteId[],
];

/**
 * Which routes can be used (L46, NEAR-only scope). A fixed constant, not configuration: nothing in
 * the environment can turn a route on. Base, Arbitrum and Solana stay in code and tests, disabled.
 */
export type RouteAvailability = "enabled" | "coming_soon" | "disabled";
export const ROUTE_AVAILABILITY: Readonly<Record<PayoutRouteId, RouteAvailability>> = {
  "usdc-base": "disabled",
  "usdc-arbitrum": "disabled",
  "usdc-solana": "disabled",
  "usdc-near": "coming_soon", // until spike S-N passes
  "usdc-near-confidential": "enabled",
  "near-direct": "coming_soon", // until spike S-NR passes
};
export const ENABLED_PAYOUT_ROUTE_IDS: readonly PayoutRouteId[] = PAYOUT_ROUTE_IDS.filter(
  (id) => ROUTE_AVAILABILITY[id] === "enabled",
);

export function getPayoutRoute(id: PayoutRouteId): PayoutRoute {
  const route = PAYOUT_ROUTES.find((r) => r.id === id);
  if (!route) throw new RangeError(`unknown payout route: ${id}`);
  return route;
}

// Funding origins (L30). Reviewed constants copied from the T1 token list,
// verification/results/T1-tokens.json (GET /v0/tokens, 2026-11-05). Data only (L5).
// `verification` says how far each is proven (L32): only USDT on BSC has funded live, in T5.
// "unproven" (W6): the quote shape follows the 1Click docs, but no quote or deposit was ever made.
// `convertsToUsdc`: the treasury holds USDC only, so any other asset is swapped on the way in.
export const FUNDING_ORIGINS = [
  {
    id: "usdc-near",
    symbol: "USDC",
    verification: "unproven",
    network: "NEAR",
    assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    decimals: 6,
    addressKind: "near",
    convertsToUsdc: false,
  },
  {
    id: "near",
    symbol: "NEAR",
    verification: "unproven",
    network: "NEAR",
    assetId: "nep141:wrap.near",
    decimals: 24,
    addressKind: "near",
    convertsToUsdc: true,
  },
  {
    id: "usdt-near",
    symbol: "USDT",
    verification: "unproven",
    network: "NEAR",
    assetId: "nep141:usdt.tether-token.near",
    decimals: 6,
    addressKind: "near",
    convertsToUsdc: true,
  },
  {
    id: "usdc-base",
    symbol: "USDC",
    verification: "dry_quote_only",
    network: "Base",
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    addressKind: "evm",
    convertsToUsdc: false,
  },
  {
    id: "usdc-arbitrum",
    symbol: "USDC",
    verification: "dry_quote_only",
    network: "Arbitrum",
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    decimals: 6,
    addressKind: "evm",
    convertsToUsdc: false,
  },
  {
    id: "usdc-solana",
    symbol: "USDC",
    verification: "dry_quote_only",
    network: "Solana",
    assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    decimals: 6,
    addressKind: "solana",
    convertsToUsdc: false,
  },
  {
    id: "usdt-bsc",
    symbol: "USDT",
    verification: "live",
    network: "BNB Smart Chain",
    assetId: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g",
    decimals: 18,
    addressKind: "evm",
    convertsToUsdc: true,
  },
] as const;

export type FundingOriginId = (typeof FUNDING_ORIGINS)[number]["id"];

/**
 * Which funding options the API accepts (W6). NEAR and USDT on NEAR are converted into USDC by
 * 1Click; their quote shape follows the docs but nothing was ever funded through them, so they
 * show "coming soon" until the spikes S-F2 and S-FT (VERIFICATION.md) pass. Never read from the
 * environment: enabling one is a reviewed code change after its spike.
 */
export const FUNDING_AVAILABILITY: Record<FundingOriginId, "enabled" | "coming_soon"> = {
  "usdc-near": "enabled",
  near: "coming_soon",
  "usdt-near": "coming_soon",
  "usdc-base": "enabled",
  "usdc-arbitrum": "enabled",
  "usdc-solana": "enabled",
  "usdt-bsc": "enabled",
};
export const FUNDING_ORIGIN_IDS = FUNDING_ORIGINS.map((o) => o.id) as [
  FundingOriginId,
  ...FundingOriginId[],
];
export function getFundingOrigin(id: FundingOriginId) {
  const origin = FUNDING_ORIGINS.find((o) => o.id === id);
  if (!origin) throw new RangeError(`unknown funding origin: ${id}`);
  return origin;
}

/** The funding options the API accepts: the enabled ones. Tests may pass more (never the environment). */
export const ENABLED_FUNDING_ORIGIN_IDS: readonly FundingOriginId[] = FUNDING_ORIGIN_IDS.filter(
  (id) => FUNDING_AVAILABILITY[id] === "enabled",
);
