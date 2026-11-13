// Gate A (quote authenticity) and the signed view every other gate reads.
import {
  ONECLICK_QUOTE_KEY,
  signedQuoteFields,
  verifyQuoteSignature,
  type SignedQuoteResponse,
} from "@veylo/intents";
import { z } from "zod";
import { fail, pass, type GateResult } from "./types.js";

/**
 * Pinned in the browser bundle, never taken from the API (T-2). The same key as the server's
 * versioned constant; a test proves they match. A rotation is a reviewed code change.
 */
export const PINNED_ONECLICK_QUOTE_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

/** Only fields 1Click signs, as the SDK picks them. Unsigned fields are never read. */
const signedView = z.object({
  dry: z.literal(false),
  swapType: z.literal("EXACT_OUTPUT"),
  originAsset: z.string(),
  depositType: z.string(),
  destinationAsset: z.string(),
  amount: z.string().regex(/^[1-9]\d*$/),
  refundTo: z.string(),
  refundType: z.string(),
  recipient: z.string(),
  recipientType: z.string(),
  amountIn: z.string().regex(/^[1-9]\d*$/),
  amountOut: z.string().regex(/^[1-9]\d*$/),
  depositAddress: z.string().min(1),
  timestamp: z.iso.datetime({ offset: true }),
});
export type SignedQuote = z.infer<typeof signedView>;

/**
 * The signed fields, only after the signature verifies against the pinned key. Returns undefined
 * if the signature fails or a signed field the gates need is missing or malformed.
 */
export function readSignedQuote(quote: unknown): SignedQuote | undefined {
  const response = quoteShape.safeParse(quote);
  if (!response.success) return undefined;
  const body = response.data as SignedQuoteResponse;
  if (!quoteSignatureValid(body)) return undefined;
  const signed = signedView.safeParse(signedQuoteFields(body));
  return signed.success ? signed.data : undefined;
}

/** The one place the 1Click signature is checked, against the pinned key only. */
export function quoteSignatureValid(body: SignedQuoteResponse): boolean {
  return verifyQuoteSignature(body, PINNED_ONECLICK_QUOTE_KEY);
}

const quoteShape = z
  .object({
    quote: z.record(z.string(), z.unknown()),
    quoteRequest: z.record(z.string(), z.unknown()),
    signature: z.string(),
    timestamp: z.string(),
  })
  .loose();

export function gateA(quote: unknown): GateResult {
  if (PINNED_ONECLICK_QUOTE_KEY !== ONECLICK_QUOTE_KEY.publicKey) {
    return fail("A", "pinned 1Click key doesn't match the reviewed constant");
  }
  const response = quoteShape.safeParse(quote);
  if (!response.success) return fail("A", "no quote");
  if (!quoteSignatureValid(response.data as SignedQuoteResponse)) {
    return fail("A", "1Click's signature doesn't verify against the pinned key");
  }
  const signed = readSignedQuote(quote);
  if (!signed)
    return fail("A", "the signed quote is missing a field or isn't a live exact-output quote");
  // Privacy is enforced by signed fields only, never by unsigned `confidentiality` (§6.3).
  if (signed.depositType !== "CONFIDENTIAL_INTENTS") {
    return fail("A", "the signed deposit type isn't CONFIDENTIAL_INTENTS");
  }
  return pass("A");
}

/** At least this much time must be left to sign, as the API requires (L34). */
export const MIN_SECONDS_LEFT = 60;

/**
 * The signing bound is computed here, from the quote's signed timestamp plus
 * PAYOUT_QUOTE_DEADLINE_MINUTES, never from a served deadline (L35).
 */
export function signingBound(signed: SignedQuote, deadlineMinutes: number): Date {
  if (!Number.isInteger(deadlineMinutes) || deadlineMinutes < 1 || deadlineMinutes > 60) {
    throw new RangeError("PAYOUT_QUOTE_DEADLINE_MINUTES must be 1 to 60");
  }
  return new Date(Date.parse(signed.timestamp) + deadlineMinutes * 60_000);
}

export function gateDeadline(quote: unknown, deadlineMinutes: number, now: Date): GateResult {
  const signed = readSignedQuote(quote);
  if (!signed) return fail("deadline", "no verified quote timestamp");
  const bound = signingBound(signed, deadlineMinutes);
  if (Number.isNaN(bound.getTime())) return fail("deadline", "bad quote timestamp");
  if (Date.parse(signed.timestamp) > now.getTime() + 5 * 60_000) {
    return fail("deadline", "the quote's signed timestamp is in the future");
  }
  if (bound.getTime() - now.getTime() < MIN_SECONDS_LEFT * 1000) {
    return fail("deadline", "the signing window has closed: re-quote");
  }
  return pass("deadline");
}
