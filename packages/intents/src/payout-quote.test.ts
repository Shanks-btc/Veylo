import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { TREASURY_ASSET_ID } from "@veylo/core";
import { describe, expect, it, vi } from "vitest";
import { createOneClickTreasuryClient, oneClickQuoteHash, QuoteGuardError } from "./index.js";

// A throwaway signing key standing in for 1Click's, so tests can sign quotes.
const SECRET = new Uint8Array(32).fill(3);
const PUBLIC = `ed25519:${base58.encode(ed25519.getPublicKey(SECRET))}`;
const sign = (response: object) =>
  `ed25519:${base58.encode(
    ed25519.sign(new TextEncoder().encode(oneClickQuoteHash(response as never)), SECRET),
  )}`;

const TREASURY = "a87a0e4f93085edbe787aa4530021045f426c8fbc500a7c1dbd729dc4f8151ce";
const BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const PAYEE = {
  recipient: "0xAf780910c0E7D41430D4615A437676a87a332C8C",
  recipientType: "DESTINATION_CHAIN",
  destinationAsset: BASE,
};
const NOW = new Date("2026-11-07T10:00:00.000Z");
const input = (over: object = {}) => ({
  mode: "live" as const,
  treasuryAccountId: TREASURY,
  refundTo: TREASURY,
  payee: PAYEE,
  recipient: PAYEE.recipient,
  recipientType: PAYEE.recipientType,
  destinationAsset: BASE,
  amount: "50000",
  expectedAmount: "50000",
  now: NOW,
  deadline: new Date(NOW.getTime() + 15 * 60_000),
  maxDeadlineMinutes: 15,
  ...over,
});

/** Answers like 1Click, echoing the request and signing it, with optional tampering. */
function fake(tamper: (response: any, dry: boolean) => void = () => {}, signWith = sign) {
  const sent: any[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push(body);
    const response: any = {
      quote: {
        amountIn: "52943",
        minAmountIn: "52413",
        amountOut: body.amount,
        minAmountOut: body.amount,
        withdrawFee: "2400",
        ...(body.dry
          ? {}
          : {
              depositAddress: "f".repeat(64),
              deadline: "2026-11-10T10:15:00.000Z",
              timeWhenInactive: "2026-11-10T10:15:00.000Z",
            }),
      },
      quoteRequest: { ...body },
      timestamp: "2026-11-07T10:00:01.000Z",
      correlationId: "c",
    };
    tamper(response, body.dry);
    response.signature = signWith(response);
    tamper(response, body.dry); // A second pass may change things after signing.
    return new Response(JSON.stringify(response), { status: 201 });
  });
  const client = createOneClickTreasuryClient({
    apiKey: "k",
    fetch: fetch as unknown as typeof globalThis.fetch,
    quotePublicKey: PUBLIC,
  });
  return { client, sent };
}

describe("createPayoutQuote: live", () => {
  it("sends dry then live, with every fixed field", async () => {
    const { client, sent } = fake();
    const q = await client.createPayoutQuote(input());
    expect(sent.map((s) => s.dry)).toEqual([true, false]);
    for (const s of sent) {
      expect(s).toMatchObject({
        swapType: "EXACT_OUTPUT",
        originAsset: TREASURY_ASSET_ID,
        depositType: "CONFIDENTIAL_INTENTS",
        refundType: "CONFIDENTIAL_INTENTS",
        refundTo: TREASURY,
        recipient: PAYEE.recipient,
        recipientType: "DESTINATION_CHAIN",
        destinationAsset: BASE,
        amount: "50000",
        deadline: "2026-11-07T10:15:00.000Z",
      });
    }
    expect(q).toMatchObject({
      mode: "live",
      depositAddress: "f".repeat(64),
      quoteDeadline: "2026-11-10T10:15:00.000Z",
      amountIn: "52943",
    });
    expect(q.requestedDeadline.toISOString()).toBe("2026-11-07T10:15:00.000Z");
  });
});

describe("createPayoutQuote: simulated", () => {
  it("makes only a dry quote, and returns no deposit address", async () => {
    const { client, sent } = fake();
    const q = await client.createPayoutQuote(input({ mode: "simulated" }));
    expect(sent.map((s) => s.dry)).toEqual([true]);
    expect(q.mode).toBe("simulated");
    expect(q.depositAddress).toBeUndefined();
  });
});

describe("every constraint throws before any request", () => {
  it.each<[string, object]>([
    ["recipient", { recipient: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }],
    ["recipient type", { recipientType: "CONFIDENTIAL_INTENTS" }],
    ["destination asset", { destinationAsset: "nep141:arb-x" }],
    ["refund", { refundTo: "attacker.near" }],
    ["amount", { amount: "50001" }],
    ["a zero amount", { amount: "0", expectedAmount: "0" }],
    ["a decimal amount", { amount: "1.5", expectedAmount: "1.5" }],
    ["a deadline beyond the limit", { deadline: new Date(NOW.getTime() + 15 * 60_000 + 1) }],
    ["a deadline in the past", { deadline: new Date(NOW.getTime() - 1) }],
    ["a deadline of now", { deadline: NOW }],
  ])("%s", async (_name, change) => {
    const { client, sent } = fake();
    await expect(client.createPayoutQuote(input(change))).rejects.toBeInstanceOf(QuoteGuardError);
    expect(sent).toEqual([]);
  });

  it("accepts a deadline exactly at the limit", async () => {
    const { client } = fake();
    await expect(
      client.createPayoutQuote(input({ deadline: new Date(NOW.getTime() + 15 * 60_000) })),
    ).resolves.toBeDefined();
  });
});

describe("responses are checked: signature and echo", () => {
  it("a quote signed with another key is refused, and nothing goes live", async () => {
    const other = new Uint8Array(32).fill(4);
    const { client, sent } = fake(
      () => {},
      (r) =>
        `ed25519:${base58.encode(ed25519.sign(new TextEncoder().encode(oneClickQuoteHash(r as never)), other))}`,
    );
    await expect(client.createPayoutQuote(input())).rejects.toThrow("signature");
    expect(sent).toHaveLength(1);
  });

  it("a live quote tampered after signing is refused", async () => {
    let signed = false;
    const { client } = fake((r, dry) => {
      if (!dry && signed) r.quote.depositAddress = "e".repeat(64);
      if (!dry) signed = !signed;
    });
    await expect(client.createPayoutQuote(input())).rejects.toThrow("signature");
  });

  it.each<[string, (r: any) => void]>([
    ["recipient", (r) => (r.quoteRequest.recipient = "0xevil")],
    ["recipientType", (r) => (r.quoteRequest.recipientType = "INTENTS")],
    ["depositType", (r) => (r.quoteRequest.depositType = "INTENTS")],
    ["refundTo", (r) => (r.quoteRequest.refundTo = "evil.near")],
    ["refundType", (r) => (r.quoteRequest.refundType = "INTENTS")],
    ["amount", (r) => (r.quoteRequest.amount = "1")],
    ["destinationAsset", (r) => (r.quoteRequest.destinationAsset = "nep141:other")],
    ["deadline", (r) => (r.quoteRequest.deadline = "2030-01-01T00:00:00.000Z")],
    ["swapType", (r) => (r.quoteRequest.swapType = "EXACT_INPUT")],
    ["delivered amount", (r) => (r.quote.amountOut = "1")],
  ])("a correctly signed quote echoing a different %s is refused", async (_name, change) => {
    const { client } = fake((r) => {
      if (!r.signature) change(r);
    });
    await expect(client.createPayoutQuote(input())).rejects.toBeInstanceOf(QuoteGuardError);
  });
});
