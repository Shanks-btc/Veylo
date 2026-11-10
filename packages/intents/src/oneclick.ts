import { TREASURY_ASSET_ID, type PayoutRoute } from "@veylo/core";
import { z } from "zod";

export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com";
/** The amount a destination's acceptance check quotes: EXACT_OUTPUT 1 USDC. */
export const ACCEPTANCE_AMOUNT = "1000000";

/**
 * Everything a dry quote can say. `dry` isn't a field: the client always sets it, and strict parsing
 * refuses a caller that tries to pass it.
 */
const dryQuoteInput = z
  .object({
    swapType: z.literal("EXACT_OUTPUT"),
    slippageTolerance: z.number().int().min(0),
    originAsset: z.string().min(1),
    depositType: z.enum(["INTENTS", "CONFIDENTIAL_INTENTS"]),
    destinationAsset: z.string().min(1),
    amount: z.string().regex(/^[1-9]\d*$/),
    recipient: z.string().min(1),
    recipientType: z.enum(["DESTINATION_CHAIN", "INTENTS", "CONFIDENTIAL_INTENTS"]),
    refundTo: z.string().min(1),
    refundType: z.enum(["INTENTS", "CONFIDENTIAL_INTENTS"]),
    deadline: z.iso.datetime(),
  })
  .strict();

export type DryQuoteInput = z.input<typeof dryQuoteInput>;

const units = z.string().regex(/^\d+$/);
const acceptedResponse = z.object({
  quote: z.looseObject({
    amountIn: units,
    minAmountIn: units,
    amountOut: units,
    withdrawFee: units,
    // A real quote carries a deposit address. A dry one must not.
    depositAddress: z.undefined().optional(),
  }),
  quoteRequest: z.looseObject({ dry: z.literal(true) }),
});

/** As recorded in T2: "Quoting for this pair is not available". */
const PAIR_UNAVAILABLE = /pair is not available/i;

export type DryQuoteResult =
  | {
      readonly outcome: "accepted";
      readonly amountIn: string;
      readonly minAmountIn: string;
      readonly amountOut: string;
      readonly withdrawFee: string;
    }
  /** 1Click refused the address. Final. `reason` is its own message. */
  | { readonly outcome: "rejected"; readonly reason: string }
  /** 1Click can't quote this route right now. Not about the address, so retryable (L27). */
  | { readonly outcome: "route_unavailable"; readonly reason: string }
  /** We got no answer about the quote: network, timeout, auth, rate limit. Retryable. */
  | { readonly outcome: "check_failed"; readonly reason: string };

export type OneClickDryClient = {
  dryQuote(input: DryQuoteInput): Promise<DryQuoteResult>;
};

/** Refuses to send anything but a dry quote. The last check before the network. */
export function assertDry(body: { dry?: unknown }): void {
  if (body.dry !== true) throw new Error("this client only sends dry quotes");
}

/** Never logs the API key, the request or the response: only status, outcome and timing. */
export type OneClickLogEvent = { status?: number; outcome: DryQuoteResult["outcome"]; ms: number };

export function createOneClickDryClient(options: {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
  log?: (event: OneClickLogEvent) => void;
}): OneClickDryClient {
  const url = `${options.baseUrl ?? ONECLICK_BASE_URL}/v0/quote`;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async dryQuote(input) {
      const started = performance.now();
      const done = (result: DryQuoteResult, status?: number) => {
        options.log?.({
          ...(status === undefined ? {} : { status }),
          outcome: result.outcome,
          ms: Math.round(performance.now() - started),
        });
        return result;
      };

      const body = { ...dryQuoteInput.parse(input), dry: true };
      assertDry(body);

      let response: Response;
      let json: unknown;
      try {
        response = await options.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": options.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        json = await response.json();
      } catch {
        return done({ outcome: "check_failed", reason: "1Click did not answer" });
      }

      const { status } = response;
      if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) {
        return done({ outcome: "check_failed", reason: `1Click returned HTTP ${status}` }, status);
      }
      if (!response.ok) {
        const message = z.object({ message: z.string().min(1).max(500) }).safeParse(json);
        return done(
          message.success
            ? {
                outcome: PAIR_UNAVAILABLE.test(message.data.message)
                  ? "route_unavailable"
                  : "rejected",
                reason: message.data.message,
              }
            : { outcome: "check_failed", reason: `1Click returned HTTP ${status}` },
          status,
        );
      }
      const parsed = acceptedResponse.safeParse(json);
      if (!parsed.success) {
        return done(
          { outcome: "check_failed", reason: "1Click sent an unexpected response" },
          status,
        );
      }
      const { amountIn, minAmountIn, amountOut, withdrawFee } = parsed.data.quote;
      return done({ outcome: "accepted", amountIn, minAmountIn, amountOut, withdrawFee }, status);
    },
  };
}

/**
 * The dry quote that decides whether 1Click accepts a destination (rule 1). Paid from the
 * confidential treasury, refunded to it, as in T5b (Direct) and T5c (Private).
 */
export function acceptanceQuote(input: {
  route: PayoutRoute;
  recipient: string;
  treasuryAccountId: string;
  deadline: Date;
  amount?: string;
}): DryQuoteInput {
  return {
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: TREASURY_ASSET_ID,
    depositType: "CONFIDENTIAL_INTENTS",
    destinationAsset: input.route.assetId,
    amount: input.amount ?? ACCEPTANCE_AMOUNT,
    recipient: input.recipient,
    recipientType: input.route.recipientType,
    refundTo: input.treasuryAccountId,
    refundType: "CONFIDENTIAL_INTENTS",
    deadline: input.deadline.toISOString(),
  };
}
