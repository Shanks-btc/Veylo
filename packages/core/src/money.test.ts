import { describe, expect, it } from "vitest";
import { MoneyError } from "./errors.js";
import {
  addMoney,
  defineAsset,
  formatAmount,
  money,
  parseAmount,
  parseUnits,
  subtractMoney,
  USDC,
} from "./money.js";

describe("USDC", () => {
  it("has 6 decimals and the verified asset ID", () => {
    expect(USDC.decimals).toBe(6);
    expect(USDC.assetId).toBe(
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    );
  });
});

describe("parseAmount", () => {
  it.each([
    ["0", 0n],
    ["0.5", 500000n],
    ["1", 1000000n],
    ["0.000001", 1n],
    ["10.000000", 10000000n],
    ["123456789.123456", 123456789123456n],
  ])("parses %s", (input, units) => {
    expect(parseAmount(input, USDC).units).toBe(units);
  });

  it.each([
    ["negative", "-1"],
    ["plus sign", "+1"],
    ["over-precision", "0.0000001"],
    ["over-precision with zeros", "1.0000000"],
    ["exponent", "1e6"],
    ["empty", ""],
    ["whitespace", " 1"],
    ["trailing whitespace", "1 "],
    ["bare point", "."],
    ["leading point", ".5"],
    ["trailing point", "1."],
    ["leading zero", "01"],
    ["comma", "1,000"],
    ["two points", "1.2.3"],
    ["hex", "0x10"],
    ["word", "NaN"],
    ["infinity", "Infinity"],
  ])("rejects %s", (_label, input) => {
    expect(() => parseAmount(input, USDC)).toThrow(MoneyError);
  });

  it("rejects non-string input", () => {
    expect(() => parseAmount(1.5 as unknown as string, USDC)).toThrow(MoneyError);
  });

  it("is exact where floating point is not", () => {
    expect(parseAmount("0.1", USDC).units + parseAmount("0.2", USDC).units).toBe(300000n);
    const big = defineAsset("big", 18);
    expect(parseAmount("9007199254.740993000000000001", big).units).toBe(
      9007199254740993000000000001n,
    );
  });
});

describe("parseUnits", () => {
  it("parses digit strings exactly", () => {
    expect(parseUnits("502503", USDC).units).toBe(502503n);
    expect(parseUnits("0", USDC).units).toBe(0n);
    expect(parseUnits("9007199254740993", USDC).units).toBe(9007199254740993n);
  });

  it.each(["-1", "1.5", "", " 1", "01", "1e6", "0x10"])("rejects %j", (input) => {
    expect(() => parseUnits(input, USDC)).toThrow(MoneyError);
  });
});

describe("money", () => {
  it("rejects negative amounts", () => {
    expect(() => money(USDC, -1n)).toThrow(MoneyError);
  });

  it("rejects numbers, so no float can enter", () => {
    expect(() => money(USDC, 1 as unknown as bigint)).toThrow(MoneyError);
    expect(() => money(USDC, 0.5 as unknown as bigint)).toThrow(MoneyError);
  });
});

describe("formatAmount", () => {
  it.each([
    [0n, "0"],
    [1n, "0.000001"],
    [500000n, "0.5"],
    [502503n, "0.502503"],
    [1000000n, "1"],
    [1500000n, "1.5"],
    [1234567890000n, "1234567.89"],
  ])("formats %s", (units, text) => {
    expect(formatAmount(money(USDC, units))).toBe(text);
  });

  it("handles an asset with no decimals", () => {
    expect(formatAmount(money(defineAsset("whole", 0), 42n))).toBe("42");
  });

  it("round-trips", () => {
    for (const text of ["0", "0.5", "0.000001", "1234.567891"]) {
      expect(formatAmount(parseAmount(text, USDC))).toBe(text);
    }
  });
});

describe("arithmetic", () => {
  const other = defineAsset("other", 6);

  it("adds and subtracts", () => {
    expect(addMoney(money(USDC, 2n), money(USDC, 3n)).units).toBe(5n);
    expect(subtractMoney(money(USDC, 3n), money(USDC, 2n)).units).toBe(1n);
  });

  it("refuses to go negative", () => {
    expect(() => subtractMoney(money(USDC, 1n), money(USDC, 2n))).toThrow(MoneyError);
  });

  it("refuses to combine different assets", () => {
    expect(() => addMoney(money(USDC, 1n), money(other, 1n))).toThrow(MoneyError);
    expect(() => subtractMoney(money(USDC, 1n), money(other, 1n))).toThrow(MoneyError);
  });
});

describe("defineAsset", () => {
  it.each([
    ["", 6],
    ["asset", -1],
    ["asset", 1.5],
    ["asset", 37],
  ])("rejects (%j, %s)", (id, decimals) => {
    expect(() => defineAsset(id, decimals)).toThrow(MoneyError);
  });
});
