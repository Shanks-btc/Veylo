import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { oneClickQuoteHash, stableStringify, verifyQuoteSignature } from "./index.js";

// Recorded 1Click responses (T5, T5b, T5c), copied as data. S-C verified these same ones.
const fx = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/quote-${name}.json`, import.meta.url), "utf8")).body;
const RECORDED = ["c2-live", "payout-live", "private-dry", "base-dry"];

describe("recorded quotes", () => {
  it.each(RECORDED)("%s verifies against the pinned key", (name) => {
    expect(verifyQuoteSignature(fx(name))).toBe(true);
  });

  it("fails against any other key", () => {
    expect(
      verifyQuoteSignature(fx("c2-live"), "ed25519:CLfSXSJR9qqkHNPXmiPRuFqeyCh5eLtMYBj4ZbDTCBvD"),
    ).toBe(false);
  });
});

describe("tampering with a signed field fails (S-C's list)", () => {
  const edit = (change: (b: any) => void) => {
    const body = structuredClone(fx("c2-live"));
    change(body);
    return verifyQuoteSignature(body);
  };
  it.each<[string, (b: any) => void]>([
    ["quote.depositAddress", (b) => (b.quote.depositAddress = "a".repeat(64))],
    [
      "quoteRequest.recipient",
      (b) => (b.quoteRequest.recipient = "0x000000000000000000000000000000000000dEaD"),
    ],
    ["quoteRequest.refundTo", (b) => (b.quoteRequest.refundTo = "a".repeat(64))],
    ["quoteRequest.destinationAsset", (b) => (b.quoteRequest.destinationAsset = "nep141:other")],
    ["quoteRequest.depositType", (b) => (b.quoteRequest.depositType = "CONFIDENTIAL_INTENTS")],
    ["quoteRequest.recipientType", (b) => (b.quoteRequest.recipientType = "INTENTS")],
    ["quoteRequest.amount", (b) => (b.quoteRequest.amount = "1")],
    ["quote.deadline", (b) => (b.quote.deadline = "2030-01-01T00:00:00.000Z")],
    ["quote.amountIn", (b) => (b.quote.amountIn = "999999")],
    ["quote.amountOut", (b) => (b.quote.amountOut = "1")],
    ["quote.minAmountIn", (b) => (b.quote.minAmountIn = "1")],
    ["quote.withdrawFee", (b) => (b.quote.withdrawFee = "1")],
    ["timestamp", (b) => (b.timestamp = "2026-11-05T15:27:39.000Z")],
    ["signature from another quote", (b) => (b.signature = fx("payout-live").signature)],
    ["no signature", (b) => delete b.signature],
    ["garbage signature", (b) => (b.signature = "ed25519:!!")],
  ])("%s", (_name, change) => {
    expect(edit(change)).toBe(false);
  });

  it.each<[string, (b: any) => void]>([
    ["appFees", (b) => (b.quoteRequest.appFees = [{ recipient: "x", fee: 100 }])],
    ["confidentiality", (b) => (b.quoteRequest.confidentiality = "advanced")],
    ["depositMode", (b) => (b.quoteRequest.depositMode = "MEMO")],
  ])("%s is outside the signature, as S-C found, so it must never be relied on", (_n, change) => {
    expect(edit(change)).toBe(true);
  });
});

describe("the requested deadline (finding, slice 5a)", () => {
  // The SDK hashes { ...request, ...quote }. On a live quote, quote.deadline overwrites
  // quoteRequest.deadline, so the deadline we asked for is not covered by the signature.
  it("is NOT signed on a live quote: only the quote's own deadline is", () => {
    const body = structuredClone(fx("c2-live"));
    body.quoteRequest.deadline = "2030-01-01T00:00:00.000Z";
    expect(verifyQuoteSignature(body)).toBe(true);
  });

  it("is signed on a dry quote, which has no deadline of its own", () => {
    const body = structuredClone(fx("base-dry"));
    body.quoteRequest.deadline = "2030-01-01T00:00:00.000Z";
    expect(verifyQuoteSignature(body)).toBe(false);
  });
});

describe("stableStringify", () => {
  it("sorts keys, drops undefined members, keeps nulls, and nulls undefined array slots", () => {
    expect(stableStringify({ b: 1, a: undefined, c: null, d: [undefined, "x"] } as never)).toBe(
      '{"b":1,"c":null,"d":[null,"x"]}',
    );
  });

  it("the hash is base58 text", () => {
    expect(oneClickQuoteHash(fx("c2-live"))).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });
});
