// NEAR payouts (slice W6, part 3b). Salaries are set in USD. A NEAR payout is quoted when the
// payout is made, as EXACT_OUTPUT: the NEAR amount is sized from a reference price, 1Click quotes
// the USDC the treasury must spend to deliver exactly that much NEAR, and gate C bounds that spend.
//
// Why EXACT_OUTPUT: the contractor must receive the amount they were promised in value, and the
// treasury pays the swap fee (as it does on every payout route). EXACT_INPUT would fix what the
// company spends but let the contractor's NEAR amount drift with the rate and the fee, so the
// contractor, not the company, would carry the cost of a move between quote and settlement.
//
// The reference price only SIZES the request. It is never trusted: the signed quote's own amounts
// decide, and the browser refuses unless the USDC spent is at least the approved USD amount (the
// contractor is not short-changed) and at most the approved amount plus the fee ceiling.
import { parseDecimal12 } from "./decimal.js";

/** Yocto per NEAR, as a power of ten. */
const YOCTO_DIGITS = 24;

/**
 * NEAR in yoctoNEAR worth `usdUnits` (USD with 6 decimals) at `priceText` USD per NEAR, rounded up
 * so the contractor never gets less than the salary's value at that price. Exact bigint math.
 */
export function nearAmountForUsd(usdUnits: bigint, priceText: string): bigint {
  const price = parseDecimal12(priceText);
  if (price === undefined) throw new RangeError("not a usable NEAR price");
  if (usdUnits <= 0n) throw new RangeError("amount must be positive");
  // price has 12 decimals, usdUnits has 6: yocto = usd / price * 10^24.
  const numerator = usdUnits * 10n ** BigInt(YOCTO_DIGITS + 12 - 6);
  return (numerator + price - 1n) / price;
}

/** The most the treasury may spend on a payout of `usdUnits`: the amount plus max(1 USDC, 1%). */
export function maxSpendUnits(usdUnits: bigint): bigint {
  const percent = usdUnits / 100n;
  const one = 1_000_000n;
  return usdUnits + (percent > one ? percent : one);
}

export type NearSpendCheck = { ok: true } | { ok: false; reason: string };

/** Gate C's amount rule for a NEAR payout: spend >= the approved USD, and <= USD plus the ceiling. */
export function checkNearSpend(spentUnits: bigint, approvedUsdUnits: bigint): NearSpendCheck {
  if (spentUnits < approvedUsdUnits)
    return {
      ok: false,
      reason: "the quote spends less than the approved amount, so the contractor would be short",
    };
  if (spentUnits > maxSpendUnits(approvedUsdUnits))
    return { ok: false, reason: "the fee is above the bound" };
  return { ok: true };
}

/** USDC (6 decimals) per NEAR, from a signed quote's own amounts, to 6 decimals. */
export function impliedRateText(spentUnits: bigint, nearYocto: bigint): string | undefined {
  if (nearYocto <= 0n) return undefined;
  // spent / (yocto / 1e24) in 1e6 units, rounded half up: spent * 1e24 / yocto, kept to 6 decimals
  const scaled = (spentUnits * 10n ** BigInt(YOCTO_DIGITS) * 2n + nearYocto) / (nearYocto * 2n);
  const text = scaled.toString().padStart(7, "0");
  return `${text.slice(0, -6)}.${text.slice(-6)}`;
}
