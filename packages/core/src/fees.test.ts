import { describe, expect, it } from "vitest";
import { InconsistentQuoteError } from "./errors.js";
import { computeFee, type QuoteAmounts } from "./fees.js";
import { defineAsset, money, USDC } from "./money.js";

const usdc = (units: bigint) => money(USDC, units);
const quote = (
  amountIn: bigint,
  minAmountIn: bigint,
  amountOut: bigint,
  withdrawFee: bigint,
): QuoteAmounts => ({
  mode: "live",
  amountIn: usdc(amountIn),
  minAmountIn: usdc(minAmountIn),
  amountOut: usdc(amountOut),
  withdrawFee: usdc(withdrawFee),
});

describe("recorded Phase 2 values", () => {
  it("C2 payout: fee 2503, 50.06 bps", () => {
    const fee = computeFee(quote(507579n, 502503n, 500000n, 2400n));
    expect(fee.impliedFee.units).toBe(2503n);
    expect(fee.impliedFeeBps).toBe("50.06");
    expect(fee.impliedFeeBpsHundredths).toBe(5006n);
    expect(fee.deliveryFee.units).toBe(2400n);
    expect(fee.remainder.units).toBe(103n);
    expect(fee.slippageBuffer.units).toBe(5076n);
    expect(fee.amountIn.units).toBe(507579n);
    expect(fee.minAmountIn.units).toBe(502503n);
  });

  it("batch Base payout: fee 2423", () => {
    const fee = computeFee(quote(103458n, 102423n, 100000n, 2400n));
    expect(fee.impliedFee.units).toBe(2423n);
    expect(fee.impliedFeeBps).toBe("242.30");
    expect(fee.deliveryFee.units).toBe(2400n);
    expect(fee.remainder.units).toBe(23n);
  });

  it("batch Arbitrum payout: fee 5324", () => {
    const fee = computeFee(quote(106388n, 105324n, 100000n, 5300n));
    expect(fee.impliedFee.units).toBe(5324n);
    expect(fee.impliedFeeBps).toBe("532.40");
    expect(fee.deliveryFee.units).toBe(5300n);
    expect(fee.remainder.units).toBe(24n);
  });

  it("T5b confidential payout: fee 4823", () => {
    const fee = computeFee(quote(105882n, 104823n, 100000n, 4800n));
    expect(fee.impliedFee.units).toBe(4823n);
    expect(fee.impliedFeeBps).toBe("482.30");
    expect(fee.remainder.units).toBe(23n);
  });

  it("T5c internal confidential transfer: no fee", () => {
    const fee = computeFee(quote(50506n, 50000n, 50000n, 0n));
    expect(fee.impliedFee.units).toBe(0n);
    expect(fee.impliedFeeBps).toBe("0.00");
    expect(fee.remainder.units).toBe(0n);
    expect(fee.slippageBuffer.units).toBe(506n);
  });

  it("T5d cash-out: fee 4809, 1603.00 bps", () => {
    const fee = computeFee(quote(35161n, 34809n, 30000n, 4800n));
    expect(fee.impliedFee.units).toBe(4809n);
    expect(fee.impliedFeeBps).toBe("1603.00");
    expect(fee.remainder.units).toBe(9n);
  });
});

describe("bps rounding: to the nearest hundredth of a bp, exact half up", () => {
  it.each([
    // fee / amountOut, as (fee, amountOut, expected)
    [1n, 3n, "3333.33"], // 3333.3333... rounds down
    [2n, 3n, "6666.67"], // 6666.6666... rounds up
    [1n, 2_000_000n, "0.01"], // exactly 0.005 bps: the half rounds up
    [1n, 2_000_001n, "0.00"], // just below 0.005 bps rounds down
    [3n, 2_000_000n, "0.02"], // exactly 0.015 bps: the half rounds up
    [1n, 1_000_000n, "0.01"], // exact
    [1n, 10_000n, "1.00"], // exact
    [1n, 1n, "10000.00"], // the whole amount again
  ])("fee %s of %s is %s bps", (fee, amountOut, text) => {
    const result = computeFee(quote(amountOut + fee, amountOut + fee, amountOut, 0n));
    expect(result.impliedFeeBps).toBe(text);
  });

  it("stays exact on amounts too large for a float", () => {
    const amountOut = 9007199254740993n; // Above Number.MAX_SAFE_INTEGER, so a float would lose it
    const result = computeFee(quote(amountOut + 1n, amountOut + 1n, amountOut, 0n));
    expect(result.impliedFee.units).toBe(1n);
    expect(result.impliedFeeBps).toBe("0.00");
  });
});

describe("mode", () => {
  it("carries the quote's mode", () => {
    expect(computeFee(quote(1n, 1n, 1n, 0n)).mode).toBe("live");
    expect(computeFee({ ...quote(1n, 1n, 1n, 0n), mode: "simulated" }).mode).toBe("simulated");
  });
});

describe("inconsistent quotes are refused", () => {
  it.each([
    ["amountOut is zero", 10n, 10n, 0n, 0n],
    ["amountIn below minAmountIn", 9n, 10n, 5n, 0n],
    ["minAmountIn below amountOut", 10n, 4n, 5n, 0n],
    ["withdrawFee above the implied fee", 10n, 10n, 9n, 2n],
  ])("%s", (_label, amountIn, minAmountIn, amountOut, withdrawFee) => {
    expect(() => computeFee(quote(amountIn, minAmountIn, amountOut, withdrawFee))).toThrow(
      InconsistentQuoteError,
    );
  });

  it("different decimals", () => {
    const eighteen = defineAsset("usdt-bsc", 18);
    expect(() =>
      computeFee({ ...quote(10n, 10n, 5n, 0n), amountOut: money(eighteen, 5n) }),
    ).toThrow(InconsistentQuoteError);
  });

  it("allows different assets with the same decimals, at face value", () => {
    const usdcBase = defineAsset("nep141:base-usdc", 6);
    const fee = computeFee({ ...quote(10n, 10n, 5n, 0n), amountOut: money(usdcBase, 5n) });
    expect(fee.impliedFee.units).toBe(5n);
  });
});
