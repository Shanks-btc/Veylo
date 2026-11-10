import { MoneyError } from "./errors.js";

export type Asset = {
  readonly assetId: string;
  readonly decimals: number;
};

/** An amount in an asset's smallest units. Always a non-negative bigint. */
export type Money = {
  readonly asset: Asset;
  readonly units: bigint;
};

const MAX_DECIMALS = 36;

export function defineAsset(assetId: string, decimals: number): Asset {
  if (typeof assetId !== "string" || assetId.length === 0) {
    throw new MoneyError("asset ID must be a non-empty string");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new MoneyError(`decimals must be an integer from 0 to ${MAX_DECIMALS}`);
  }
  return Object.freeze({ assetId, decimals });
}

/** Circle USDC on NEAR. Asset ID confirmed by 1Click's token list (DECISIONS, verified constants). */
export const USDC = defineAsset(
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  6,
);

/** Builds Money from smallest units. Rejects anything but a non-negative bigint. */
export function money(asset: Asset, units: bigint): Money {
  if (typeof units !== "bigint") throw new MoneyError("units must be a bigint");
  if (units < 0n) throw new MoneyError("amount must not be negative");
  return Object.freeze({ asset, units });
}

/** Parses an API's smallest-unit string, such as "502503". Digits only. */
export function parseUnits(input: string, asset: Asset): Money {
  if (typeof input !== "string" || !/^(0|[1-9][0-9]*)$/.test(input)) {
    throw new MoneyError(`not a valid smallest-unit amount: ${JSON.stringify(input)}`);
  }
  return money(asset, BigInt(input));
}

/**
 * Parses a human amount, such as "0.5". Rejects signs, exponents, whitespace, leading zeros,
 * bare or trailing points, and more fractional digits than the asset has, even if those are zeros.
 */
export function parseAmount(input: string, asset: Asset): Money {
  if (typeof input !== "string") throw new MoneyError("amount must be a string");
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(input);
  if (!match) throw new MoneyError(`not a valid amount: ${JSON.stringify(input)}`);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > asset.decimals) {
    throw new MoneyError(
      `${JSON.stringify(input)} has more than ${asset.decimals} decimal places for ${asset.assetId}`,
    );
  }
  return money(asset, BigInt(whole + fraction.padEnd(asset.decimals, "0")));
}

/** Formats as a decimal string with no trailing zeros: 500000 USDC units is "0.5". */
export function formatAmount({ asset, units }: Money): string {
  const digits = units.toString().padStart(asset.decimals + 1, "0");
  const split = digits.length - asset.decimals;
  const whole = digits.slice(0, split);
  const fraction = digits.slice(split).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function assertSameAsset(a: Money, b: Money): void {
  if (a.asset.assetId !== b.asset.assetId || a.asset.decimals !== b.asset.decimals) {
    throw new MoneyError(`cannot combine ${a.asset.assetId} with ${b.asset.assetId}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameAsset(a, b);
  return money(a.asset, a.units + b.units);
}

/** Throws rather than returning a negative amount. */
export function subtractMoney(a: Money, b: Money): Money {
  assertSameAsset(a, b);
  return money(a.asset, a.units - b.units);
}
