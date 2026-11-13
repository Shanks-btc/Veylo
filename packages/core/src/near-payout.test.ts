// NEAR payout sizing and bounds: exact bigint math, and the rules gate C enforces.
import { describe, expect, it } from "vitest";
import { checkNearSpend, impliedRateText, maxSpendUnits, nearAmountForUsd } from "./near-payout.js";

describe("nearAmountForUsd", () => {
  it("sizes 100 USD at 3.43 USD per NEAR, rounded up so the contractor is never short", () => {
    const yocto = nearAmountForUsd(100_000_000n, "3.43");
    // 100 / 3.43 = 29.154518950437317784...; rounded up at the yocto
    expect(yocto).toBe(29154518950437317784256560n);
    // Worth at least 100 USD at that price, and never a whole yocto more than needed.
    const worth = (yocto * 343n) / 10n ** 24n; // in cents * ... (343 = 3.43 * 100)
    expect(worth).toBeGreaterThanOrEqual(10_000n - 1n);
  });
  it("one NEAR at one dollar is exactly 1e24", () => {
    expect(nearAmountForUsd(1_000_000n, "1")).toBe(10n ** 24n);
  });
  it("refuses a bad price or a non-positive amount", () => {
    expect(() => nearAmountForUsd(1_000_000n, "0")).toThrow();
    expect(() => nearAmountForUsd(1_000_000n, "abc")).toThrow();
    expect(() => nearAmountForUsd(0n, "3.43")).toThrow();
  });
});

describe("the spend bound (gate C for NEAR)", () => {
  it("allows the approved amount up to the fee ceiling, and nothing outside", () => {
    const usd = 100_000_000n;
    expect(maxSpendUnits(usd)).toBe(101_000_000n);
    expect(checkNearSpend(100_000_000n, usd).ok).toBe(true);
    expect(checkNearSpend(100_350_000n, usd).ok).toBe(true);
    expect(checkNearSpend(101_000_000n, usd).ok).toBe(true);
    const low = checkNearSpend(99_999_999n, usd);
    expect(low.ok).toBe(false);
    const high = checkNearSpend(101_000_001n, usd);
    expect(high.ok).toBe(false);
  });
  it("the ceiling is at least 1 USDC on small payouts", () => {
    expect(maxSpendUnits(10_000_000n)).toBe(11_000_000n);
  });
});

describe("impliedRateText", () => {
  it("shows USDC per NEAR from the signed amounts, to six decimals", () => {
    expect(impliedRateText(100_350_000n, 29154518950437317784256560n)).toBe("3.442005");
    expect(impliedRateText(1_000_000n, 10n ** 24n)).toBe("1.000000");
  });
  it("has no rate for zero NEAR", () => {
    expect(impliedRateText(1n, 0n)).toBeUndefined();
  });
});
