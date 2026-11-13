// Display estimates are exact bigint arithmetic on decimal strings, and they stay out of money.
import { describe, expect, it } from "vitest";
import {
  DISPLAY_CURRENCIES,
  convertUsdUnits,
  displayCurrency,
  estimateText,
  formatLocal,
  parseRate,
} from "./fx.js";

const NGN = displayCurrency("NGN")!;
const JPY = displayCurrency("JPY")!;

describe("parseRate", () => {
  it("reads a decimal string exactly", () => {
    expect(parseRate("1349.822603")).toBe(1349822603000000n);
    expect(parseRate("1")).toBe(1000000000000n);
    expect(parseRate("0.000001")).toBe(1000000n);
  });
  it.each([
    "",
    "0",
    "0.0",
    "-1",
    "1e5",
    "1,5",
    " 1",
    "NaN",
    "Infinity",
    "1.1234567890123",
    "1234567890123",
  ])("refuses %j", (bad) => expect(parseRate(bad)).toBeUndefined());
});

describe("convertUsdUnits", () => {
  it("100 USDC at 1349.822603 is exactly 134,982.26 naira", () => {
    const minor = convertUsdUnits(100_000_000n, parseRate("1349.822603")!, NGN);
    expect(minor).toBe(13498226n);
    expect(formatLocal(minor, NGN)).toBe("₦134,982.26");
  });
  it("rounds half up to the currency's own decimals", () => {
    // 0.5 USD at rate 1.01 = 0.505 -> 0.51
    expect(convertUsdUnits(500_000n, parseRate("1.01")!, displayCurrency("EUR")!)).toBe(51n);
    // 0.495 -> 0.50 at 2 decimals; and a yen has none
    expect(convertUsdUnits(1_000_000n, parseRate("155.5")!, JPY)).toBe(156n);
  });
  it("never uses floating point: amounts floats get wrong stay exact", () => {
    // 0.1 + 0.2 style: 0.3 USD * 3 = 0.9 exactly
    expect(convertUsdUnits(300_000n, parseRate("3")!, displayCurrency("EUR")!)).toBe(90n);
    // 999,999,999.999999 USD rounds to exactly one billion dollars
    expect(convertUsdUnits(999_999_999_999_999n, parseRate("1")!, displayCurrency("USD")!)).toBe(
      100_000_000_000n,
    );
  });
});

describe("formatLocal and estimateText", () => {
  it("groups with commas and pads the cents", () => {
    expect(formatLocal(5n, NGN)).toBe("₦0.05");
    expect(formatLocal(123456789n, NGN)).toBe("₦1,234,567.89");
    expect(formatLocal(1234567n, JPY)).toBe("¥1,234,567");
  });
  it("says 'about' and gives no estimate without a usable rate or for USD itself", () => {
    expect(estimateText(100_000_000n, "1349.822603", "NGN")).toBe("≈ ₦134,982.26");
    expect(estimateText(100_000_000n, undefined, "NGN")).toBeUndefined();
    expect(estimateText(100_000_000n, "garbage", "NGN")).toBeUndefined();
    expect(estimateText(100_000_000n, "1", "USD")).toBeUndefined();
    expect(estimateText(100_000_000n, "1", "XXX")).toBeUndefined();
  });
  it("offers the currencies the brief names and more, each with a symbol", () => {
    const codes = DISPLAY_CURRENCIES.map((c) => c.code);
    for (const c of ["USD", "NGN", "EUR", "GBP", "KES", "INR"]) expect(codes).toContain(c);
    expect(codes.length).toBeGreaterThan(20);
    for (const c of DISPLAY_CURRENCIES) expect(c.symbol.length).toBeGreaterThan(0);
  });
});
