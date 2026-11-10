import { InconsistentQuoteError } from "./errors.js";
import type { HasMode } from "./mode.js";
import { money, type Money } from "./money.js";

/** The numbers fee math needs from a quote. Field meanings follow the 1Click quote response. */
export type QuoteAmounts = HasMode & {
  readonly amountIn: Money;
  readonly minAmountIn: Money;
  readonly amountOut: Money;
  readonly withdrawFee: Money;
};

export type FeeBreakdown = HasMode & {
  /** Recorded beside the fee basis, per L9. It includes the slippage buffer, so it is not the cost. */
  readonly amountIn: Money;
  /** The fee basis, per L9. */
  readonly minAmountIn: Money;
  /** minAmountIn minus amountOut. */
  readonly impliedFee: Money;
  /** impliedFee as hundredths of a basis point of amountOut: 5006 means 50.06 bps. */
  readonly impliedFeeBpsHundredths: bigint;
  /** impliedFeeBpsHundredths as text, always with two decimals: "50.06". */
  readonly impliedFeeBps: string;
  /** The chain delivery fee: the quote's withdrawFee (D6). */
  readonly deliveryFee: Money;
  /** impliedFee minus deliveryFee: what remains beyond delivery. */
  readonly remainder: Money;
  /** amountIn minus minAmountIn: the buffer signed but not expected to be spent. */
  readonly slippageBuffer: Money;
};

/** Rounds a non-negative ratio to the nearest integer. An exact half rounds up. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

function formatBps(hundredths: bigint): string {
  const fraction = (hundredths % 100n).toString().padStart(2, "0");
  return `${hundredths / 100n}.${fraction}`;
}

/**
 * Computes the implied fee on the L9 basis.
 *
 * Basis points are of amountOut, the amount delivered, using integer arithmetic only:
 *
 *   hundredths of a bp = (impliedFee * 1_000_000) / amountOut
 *
 * Rounding rule: to the nearest hundredth of a basis point, with an exact half rounding up.
 *
 * Origin and destination may be different assets, such as USDC on NEAR and on Base. Their amounts
 * are compared at face value, so all four amounts must share the same number of decimals.
 *
 * Throws InconsistentQuoteError, rather than guess, if the numbers can't belong to a valid quote.
 */
export function computeFee(quote: QuoteAmounts): FeeBreakdown {
  const { amountIn, minAmountIn, amountOut, withdrawFee, mode } = quote;
  const decimals = minAmountIn.asset.decimals;
  if ([amountIn, amountOut, withdrawFee].some((m) => m.asset.decimals !== decimals)) {
    throw new InconsistentQuoteError("fee math needs all amounts in the same number of decimals");
  }
  if (amountOut.units === 0n) throw new InconsistentQuoteError("amountOut must not be zero");
  if (amountIn.units < minAmountIn.units) {
    throw new InconsistentQuoteError("amountIn is below minAmountIn");
  }
  if (minAmountIn.units < amountOut.units) {
    throw new InconsistentQuoteError("minAmountIn is below amountOut");
  }

  const fee = minAmountIn.units - amountOut.units;
  if (fee < withdrawFee.units) {
    throw new InconsistentQuoteError("withdrawFee is above the implied fee");
  }
  const asset = minAmountIn.asset;
  const hundredths = divideRoundHalfUp(fee * 1_000_000n, amountOut.units);

  return Object.freeze({
    mode,
    amountIn,
    minAmountIn,
    impliedFee: money(asset, fee),
    impliedFeeBpsHundredths: hundredths,
    impliedFeeBps: formatBps(hundredths),
    deliveryFee: money(asset, withdrawFee.units),
    remainder: money(asset, fee - withdrawFee.units),
    slippageBuffer: money(asset, amountIn.units - minAmountIn.units),
  });
}
