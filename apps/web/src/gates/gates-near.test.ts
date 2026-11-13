// Gate C for a NEAR payout (slice W6, part 3b): the item is a USD amount, the quote delivers an
// exact NEAR amount, and what the treasury spends must be the approved USD or a little more.
// The signature path is covered by gates.test.ts with real fixtures; here gateCSigned takes the
// signed view directly, and the payload is the real one 1Click generated for the T5b payout, whose
// amountIn and deposit address the view keeps.
import { readFileSync } from "node:fs";
import { getPayoutRoute } from "@veylo/core";
import { nonceSaltHex } from "@veylo/intents";
import { describe, expect, it } from "vitest";
import { gateCSigned } from "./index";
import type { SignedQuote } from "./signed-quote";

const fixture = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const REAL = fixture("../../../../packages/intents/src/fixtures/quote-payout-live.json").body;
const PAYLOAD = fixture("./fixtures/t5b-generated-intent.json").payload;
const SALT = nonceSaltHex(PAYLOAD.nonce) as string;
const TREASURY = REAL.quoteRequest.refundTo as string;

const NEAR = getPayoutRoute("near-direct");
const USDC_ROUTE = getPayoutRoute("usdc-near-confidential");
const YOCTO = "29154518950437317784256560";

const view = (over: Partial<SignedQuote> = {}): SignedQuote => ({
  dry: false,
  swapType: "EXACT_OUTPUT",
  originAsset: REAL.quoteRequest.originAsset,
  depositType: "CONFIDENTIAL_INTENTS",
  destinationAsset: "nep141:wrap.near",
  amount: YOCTO,
  amountOut: YOCTO,
  amountIn: REAL.quote.amountIn,
  refundTo: TREASURY,
  refundType: "CONFIDENTIAL_INTENTS",
  recipient: "kwame.near",
  recipientType: "DESTINATION_CHAIN",
  depositAddress: REAL.quote.depositAddress,
  timestamp: "2026-11-05T17:30:00.000Z",
  ...over,
});
const run = (usd: string, signed: SignedQuote = view(), route = NEAR) =>
  gateCSigned(signed, {
    item: { id: "i", contractorId: "c", destinationId: "d", amount: usd } as never,
    payload: PAYLOAD,
    treasuryAccountId: TREASURY,
    saltHex: SALT,
    route,
  });

describe("gate C for NEAR", () => {
  it("passes when the treasury spends the approved USD plus a small fee for an exact NEAR amount", () => {
    // 0.100000 USD approved; the recorded quote spends 0.105882 USDC.
    expect(run("0.100000")).toEqual({ gate: "C", passed: true, reason: "ok" });
  });

  it("refuses when the quote spends less than the approved USD: the contractor would be short", () => {
    const r = run("0.110000");
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/short/);
  });

  it("refuses when the fee is above the bound", () => {
    const r = run("0.100000", view({ amountIn: "5000000" }));
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/fee/);
  });

  it("refuses a quote that pays another asset than the payee's route", () => {
    const r = run("0.100000", view({ destinationAsset: "nep141:usdt.tether-token.near" }));
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/another asset/);
  });

  it("refuses a quote whose NEAR amount isn't its own exact output", () => {
    expect(run("0.100000", view({ amount: "1" })).passed).toBe(false);
  });

  it("still refuses refunds that go elsewhere and a deposit address the payload doesn't match", () => {
    expect(run("0.100000", view({ refundTo: "attacker.near" })).passed).toBe(false);
    expect(run("0.100000", view({ depositAddress: "0xnotthedepositaddress" })).passed).toBe(false);
  });

  it("a USDC route is untouched: the quote must deliver exactly the item's amount", () => {
    const usdc = view({
      destinationAsset: USDC_ROUTE.assetId,
      amount: "100000",
      amountOut: "100000",
    });
    expect(run("0.100000", usdc, USDC_ROUTE).passed).toBe(true);
    expect(run("0.200000", usdc, USDC_ROUTE).passed).toBe(false);
  });
});
