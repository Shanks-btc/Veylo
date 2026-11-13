// Gate F: the funding quote is checked in the browser before any deposit address is shown. The
// fixture is the real live quote from T5 (USDT on BNB Smart Chain into the treasury), signed by
// 1Click's real key.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkFundingQuote } from "./funding";

const QUOTE = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/intents/src/fixtures/treasury-funding-live.json",
      import.meta.url,
    ),
    "utf8",
  ),
).body;
const signedAt = Date.parse(QUOTE.quote.timestamp ?? QUOTE.timestamp);
const NOW = new Date(signedAt + 2 * 60_000);

const expected = {
  treasuryAccountId: QUOTE.quoteRequest.recipient as string,
  originAssetId: QUOTE.quoteRequest.originAsset as string,
  amount: QUOTE.quoteRequest.amount as string,
  refundAddress: QUOTE.quoteRequest.refundTo as string,
};
const served = (
  over: Partial<{ signedQuote: unknown; depositAddress: string; amountOut: string }> = {},
) => ({
  signedQuote: QUOTE,
  depositAddress: QUOTE.quote.depositAddress as string,
  amountOut: QUOTE.quote.amountOut as string,
  ...over,
});
const clone = () => JSON.parse(JSON.stringify(QUOTE));
const check = (s = served(), e = expected, now = NOW) =>
  checkFundingQuote({ served: s, expected: e, now });

describe("gate F: funding quote", () => {
  it("accepts the real signed quote when everything is what the person asked for", () => {
    const r = check();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.depositAddress).toBe(QUOTE.quote.depositAddress);
      expect(r.amountOut).toBe(QUOTE.quote.amountOut);
    }
  });

  it("refuses a quote whose signed fields were changed (the signature fails)", () => {
    for (const [field, value] of [
      ["depositAddress", "0x0000000000000000000000000000000000000bad"],
      ["amountOut", "9999999999"],
      ["amountIn", "1"],
    ] as const) {
      const q = clone();
      q.quote[field] = value;
      const r = check(served({ signedQuote: q }));
      expect(r.ok, field).toBe(false);
    }
    const q = clone();
    q.quoteRequest.recipient = "attacker.near";
    const r = check(served({ signedQuote: q }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/signature/);
  });

  it("refuses a deposit address that is not the signed one, even if the signature is fine", () => {
    const r = check(served({ depositAddress: "0x0000000000000000000000000000000000000bad" }));
    expect(r).toEqual({ ok: false, reason: "the deposit address isn't the one 1Click signed" });
  });

  it("refuses an amount you receive that differs from the signed one", () => {
    const r = check(served({ amountOut: "1" }));
    expect(r.ok).toBe(false);
  });

  it.each([
    ["the treasury", { treasuryAccountId: "someone-else.near" }, /your treasury/],
    [
      "the refund address",
      { refundAddress: "0x1111111111111111111111111111111111111111" },
      /refunds/,
    ],
    ["the amount", { amount: "2000000000000000001" }, /amount/],
    ["the asset", { originAssetId: "nep141:wrap.near" }, /another asset/],
  ])("refuses when it is not %s the person asked for", (_what, over, reason) => {
    const r = check(served(), { ...expected, ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it("compares an EVM refund address ignoring case, and nothing else", () => {
    const r = check(served(), { ...expected, refundAddress: expected.refundAddress.toLowerCase() });
    expect(r.ok).toBe(true);
  });

  it("refuses a quote from the future and one that has expired", () => {
    expect(check(served(), expected, new Date(signedAt - 6 * 60_000)).ok).toBe(false);
    expect(check(served(), expected, new Date(signedAt + 40 * 60_000)).ok).toBe(false);
  });

  it("refuses something that is not a signed quote at all", () => {
    expect(check(served({ signedQuote: { quote: {} } })).ok).toBe(false);
    expect(check(served({ signedQuote: null })).ok).toBe(false);
  });

  it("refuses a payout quote (EXACT_OUTPUT) dressed up as a funding quote", () => {
    const payout = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/intents/src/fixtures/quote-payout-live.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ).body;
    const r = check(
      served({
        signedQuote: payout,
        depositAddress: payout.quote.depositAddress,
        amountOut: payout.quote.amountOut,
      }),
      { ...expected, treasuryAccountId: payout.quoteRequest.recipient },
    );
    expect(r.ok).toBe(false);
  });
});
