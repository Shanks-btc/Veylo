import { describe, expect, it } from "vitest";
import { csvCell, formatFixed, toCsv } from "./csv.js";

describe("formatFixed", () => {
  it.each([
    [50000n, 6, "0.050000"],
    [1n, 6, "0.000001"],
    [0n, 6, "0.000000"],
    [1234567890n, 6, "1234.567890"],
    [2000000000000000000n, 18, "2.000000000000000000"],
    [123456789012345678901234567890n, 6, "123456789012345678901234.567890"],
    [-1500n, 6, "-0.001500"],
    [7n, 0, "7"],
  ] as const)("%s with %i decimals is %s", (units, decimals, text) => {
    expect(formatFixed(units, decimals)).toBe(text);
  });

  it("refuses odd decimals", () => {
    expect(() => formatFixed(1n, -1)).toThrow(RangeError);
    expect(() => formatFixed(1n, 1.5)).toThrow(RangeError);
  });
});

describe("csvCell: CSV injection (OWASP)", () => {
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", '=HYPERLINK("http://x")'])(
    "neutralizes %j",
    (v) => {
      expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );

  it.each(["Ada", "0.050000", "0xAf78", "a=b", ""])("leaves %j alone", (v) => {
    expect(csvCell(v)).toBe(v);
  });
});

describe("csvCell: RFC 4180", () => {
  it.each([
    ['say "hi"', '"say ""hi"""'],
    ["a,b", '"a,b"'],
    ["line\nbreak", '"line\nbreak"'],
    ["cr\rhere", '"cr\rhere"'],
  ])("quotes %j", (v, out) => {
    expect(csvCell(v)).toBe(out);
  });

  it("quotes a neutralized cell that also needs quoting", () => {
    expect(csvCell('=a,"b"')).toBe('"\'=a,""b"""');
  });

  it("null and undefined are empty", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  it("uses CRLF, a header and a trailing CRLF", () => {
    expect(toCsv(["a", "b"], [["1", null]])).toBe("a,b\r\n1,\r\n");
  });

  it("refuses ragged rows", () => {
    expect(() => toCsv(["a"], [["1", "2"]])).toThrow(RangeError);
  });
});
