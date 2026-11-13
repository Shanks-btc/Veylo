// Gate F (slice W6): a funding quote is checked in the browser before any deposit instruction is
// shown. The API (possibly compromised, T-2) serves the quote, the deposit address and the amounts;
// this reads only what 1Click signed, after the signature verifies against the pinned key (gate A),
// and compares it with what the person asked for: their own treasury receives the funds, a refund
// goes back where they said, the amount is the amount, and the deposit address in the signed quote
// is the one on screen. Anything else shows no address at all.
import { TREASURY_ASSET_ID } from "@veylo/core";
import { signedQuoteFields, type SignedQuoteResponse } from "@veylo/intents";
import { z } from "zod";
import { quoteSignatureValid } from "./signed-quote.js";

const shape = z
  .object({
    quote: z.record(z.string(), z.unknown()),
    quoteRequest: z.record(z.string(), z.unknown()),
    signature: z.string(),
    timestamp: z.string(),
  })
  .loose();

/** The signed fields of a funding (EXACT_INPUT, origin-chain deposit) quote. */
const fundingView = z.object({
  dry: z.literal(false),
  swapType: z.literal("EXACT_INPUT"),
  originAsset: z.string(),
  depositType: z.literal("ORIGIN_CHAIN"),
  destinationAsset: z.string(),
  amount: z.string().regex(/^[1-9]\d*$/),
  refundTo: z.string(),
  refundType: z.literal("ORIGIN_CHAIN"),
  recipient: z.string(),
  recipientType: z.literal("INTENTS"),
  amountIn: z.string().regex(/^[1-9]\d*$/),
  amountOut: z.string().regex(/^[1-9]\d*$/),
  depositAddress: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
});

export type FundingCheck =
  | {
      readonly ok: true;
      readonly depositAddress: string;
      readonly amountIn: string;
      readonly amountOut: string;
    }
  | { readonly ok: false; readonly reason: string };

const SKEW_MS = 5 * 60_000;
const MAX_AGE_MS = 35 * 60_000;

const sameAddress = (a: string, b: string) =>
  a === b || (/^0x[0-9a-f]{40}$/i.test(a) && a.toLowerCase() === b.toLowerCase());

export function checkFundingQuote(input: {
  /** What the API served. */
  served: { signedQuote: unknown; depositAddress: string; amountOut: string };
  /** What the person asked for, from this browser, never from the API. */
  expected: {
    treasuryAccountId: string;
    originAssetId: string;
    amount: string;
    refundAddress: string;
  };
  now: Date;
}): FundingCheck {
  const response = shape.safeParse(input.served.signedQuote);
  if (!response.success) return { ok: false, reason: "the quote has no signature" };
  if (!quoteSignatureValid(response.data as SignedQuoteResponse))
    return { ok: false, reason: "1Click's signature doesn't verify against the pinned key" };
  const parsed = fundingView.safeParse(signedQuoteFields(response.data as SignedQuoteResponse));
  if (!parsed.success) return { ok: false, reason: "the signed quote isn't a live funding quote" };
  const s = parsed.data;
  const e = input.expected;
  if (s.originAsset !== e.originAssetId)
    return { ok: false, reason: "the quote is for another asset" };
  if (s.destinationAsset !== TREASURY_ASSET_ID)
    return { ok: false, reason: "the quote doesn't end in USDC" };
  if (s.recipient !== e.treasuryAccountId)
    return { ok: false, reason: "the quote pays someone other than your treasury" };
  if (!sameAddress(s.refundTo, e.refundAddress))
    return { ok: false, reason: "the quote refunds to another address" };
  if (s.amount !== e.amount || s.amountIn !== e.amount)
    return { ok: false, reason: "the quote is for another amount" };
  if (s.depositAddress !== input.served.depositAddress)
    return { ok: false, reason: "the deposit address isn't the one 1Click signed" };
  if (s.amountOut !== input.served.amountOut)
    return { ok: false, reason: "the amount you receive isn't the one 1Click signed" };
  const signedAt = Date.parse(s.timestamp);
  const now = input.now.getTime();
  if (signedAt > now + SKEW_MS) return { ok: false, reason: "the quote is dated in the future" };
  if (now - signedAt > MAX_AGE_MS)
    return { ok: false, reason: "the quote has expired: ask for a new one" };
  return {
    ok: true,
    depositAddress: s.depositAddress,
    amountIn: s.amountIn,
    amountOut: s.amountOut,
  };
}
