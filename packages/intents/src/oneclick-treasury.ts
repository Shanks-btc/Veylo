// The only 1Click client that can create a live quote (L30). There is no generic quote method and no
// exported way to send one: each purpose has its own function, which enforces where money can go.
// Payout quotes don't exist until slice 5.
import { TREASURY_ASSET_ID } from "@veylo/core";
import { z } from "zod";
import { ONECLICK_BASE_URL } from "./oneclick.js";
import { ONECLICK_QUOTE_KEY, verifyQuoteSignature } from "./quote-signature.js";

export class OneClickError extends Error {
  constructor(
    readonly kind: "unavailable" | "unauthorized" | "rejected" | "unexpected",
    /** Safe to show: 1Click's own refusal message, or our own text. Never a token. */
    readonly detail: string,
  ) {
    super(detail);
    this.name = "OneClickError";
  }
}

/** A caller tried to send money somewhere this purpose doesn't allow. A bug, or an attack. */
export class QuoteGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteGuardError";
  }
}

const units = z.string().regex(/^\d+$/);
const quoteResponse = z.object({
  quote: z.looseObject({
    amountIn: units,
    minAmountIn: units,
    amountOut: units,
    minAmountOut: units,
    depositAddress: z.string().min(1).optional(),
    deadline: z.string().optional(),
    withdrawFee: z.union([z.string(), z.number()]).optional(),
  }),
  quoteRequest: z.looseObject({
    dry: z.boolean(),
    swapType: z.string().optional(),
    amount: z.string().optional(),
    deadline: z.string().optional(),
    originAsset: z.string().optional(),
    recipient: z.string(),
    recipientType: z.string(),
    refundTo: z.string(),
    refundType: z.string(),
    depositType: z.string(),
    destinationAsset: z.string(),
  }),
  signature: z.string().optional(),
  correlationId: z.string().optional(),
  timestamp: z.string().optional(),
});
type QuoteResponse = z.infer<typeof quoteResponse>;

export type LiveQuote = {
  readonly depositAddress: string;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly minAmountOut: string;
  readonly deadline: string;
  readonly correlationId: string;
  /** The whole signed response, kept for the audit trail and gate A. */
  readonly raw: QuoteResponse;
};

const tokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
  refreshExpiresIn: z.number().int().positive(),
});
const refreshed = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});
const balances = z.object({
  balances: z.array(z.object({ tokenId: z.string(), available: units, source: z.string() })),
});
const generated = z.object({
  intent: z.object({
    standard: z.literal("nep413"),
    payload: z.object({ message: z.string(), nonce: z.string(), recipient: z.string() }).strict(),
  }),
  correlationId: z.string().optional(),
});
const submitted = z.object({ intentHash: z.string().min(1), correlationId: z.string().optional() });
const status = z.looseObject({ status: z.string().min(1), updatedAt: z.string().optional() });

export type Nep413SignedData = {
  standard: "nep413";
  payload: { message: string; nonce: string; recipient: string };
  public_key: string;
  signature: string;
};

export type PayoutQuote = {
  readonly mode: "live" | "simulated";
  /** Absent for a simulated run: only a dry quote was made. */
  readonly depositAddress?: string;
  readonly amountIn: string;
  readonly minAmountIn: string;
  readonly amountOut: string;
  readonly withdrawFee: string;
  readonly requestedDeadline: Date;
  /** The quote's own deadline. S-E2: the signed message has carried this same value. */
  readonly quoteDeadline?: string;
  readonly correlationId: string;
  readonly raw: QuoteResponse;
};

export type OneClickTreasuryClient = ReturnType<typeof createOneClickTreasuryClient>;

export function createOneClickTreasuryClient(options: {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** 1Click's quote-signing key (S-C). Defaults to the pinned, versioned key. */
  quotePublicKey?: string;
}) {
  const quotePublicKey = options.quotePublicKey ?? ONECLICK_QUOTE_KEY.publicKey;
  const base = options.baseUrl ?? ONECLICK_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(
    schema: z.ZodType<T>,
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; bearer?: string },
  ): Promise<T> {
    let response: Response;
    let json: unknown;
    try {
      response = await options.fetch(`${base}${path}`, {
        method: init.method,
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          // The status endpoint returned 404 without the partner key in T5b.
          "x-api-key": options.apiKey,
          ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      json = await response.json();
    } catch {
      throw new OneClickError("unavailable", "1Click did not answer");
    }
    if (response.status === 401 || response.status === 403) {
      throw new OneClickError("unauthorized", `1Click returned HTTP ${response.status}`);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new OneClickError("unavailable", `1Click returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      const message = z.object({ message: z.string().max(500) }).safeParse(json);
      throw new OneClickError(
        "rejected",
        message.success ? message.data.message : `1Click returned HTTP ${response.status}`,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new OneClickError("unexpected", "1Click sent an unexpected response");
    return parsed.data;
  }

  const quote = (body: object) => call(quoteResponse, "/v0/quote", { method: "POST", body });

  /** The response must echo what we asked, and only a live one has a deposit address. */
  function checkEcho(
    response: QuoteResponse,
    expected: { recipient: string; recipientType: string; refundTo: string },
  ) {
    const q = response.quoteRequest;
    if (
      q.recipient !== expected.recipient ||
      q.recipientType !== expected.recipientType ||
      q.refundTo !== expected.refundTo
    ) {
      throw new QuoteGuardError("1Click echoed a different recipient or refund");
    }
  }

  function toLive(response: QuoteResponse): LiveQuote {
    const { depositAddress, deadline } = response.quote;
    if (!depositAddress || !deadline || response.quoteRequest.dry) {
      throw new OneClickError("unexpected", "1Click sent no deposit address");
    }
    return {
      depositAddress,
      deadline,
      amountIn: response.quote.amountIn,
      amountOut: response.quote.amountOut,
      minAmountOut: response.quote.minAmountOut,
      correlationId: response.correlationId ?? "",
      raw: response,
    };
  }

  /** Dry first, then live, with the same request. A refused dry quote never reaches live. */
  async function dryThenLive(
    body: Record<string, unknown>,
    expected: { recipient: string; recipientType: string; refundTo: string },
  ): Promise<LiveQuote> {
    checkEcho(await quote({ ...body, dry: true }), expected);
    const live = await quote({ ...body, dry: false });
    checkEcho(live, expected);
    return toLive(live);
  }

  /**
   * Payouts (L30, L34): the only way to quote a payout. Every constraint is checked here, not by the
   * caller, so a bug elsewhere can't send money anywhere else. Both responses must carry 1Click's
   * signature (server-side gate A, S-C) and echo exactly what was asked.
   */
  async function payoutQuote(input: {
    mode: "live" | "simulated";
    treasuryAccountId: string;
    refundTo: string;
    /** What the treasury signed for this destination (gate B). */
    payee: { recipient: string; recipientType: string; destinationAsset: string };
    recipient: string;
    recipientType: string;
    destinationAsset: string;
    amount: string;
    expectedAmount: string;
    now: Date;
    deadline: Date;
    maxDeadlineMinutes: number;
  }): Promise<PayoutQuote> {
    if (input.recipient !== input.payee.recipient) {
      throw new QuoteGuardError("the recipient isn't the owner-signed payee");
    }
    if (input.recipientType !== input.payee.recipientType) {
      throw new QuoteGuardError("the recipient type isn't the owner-signed one");
    }
    if (input.destinationAsset !== input.payee.destinationAsset) {
      throw new QuoteGuardError("the destination asset isn't the owner-signed route");
    }
    if (input.refundTo !== input.treasuryAccountId) {
      throw new QuoteGuardError("a payout refund must go to the org's own treasury");
    }
    if (!/^[1-9]\d*$/.test(input.amount) || input.amount !== input.expectedAmount) {
      throw new QuoteGuardError("the amount isn't the item's amount");
    }
    const ms = input.deadline.getTime() - input.now.getTime();
    if (ms <= 0 || ms > input.maxDeadlineMinutes * 60_000) {
      throw new QuoteGuardError("the deadline must be in the future and within the payout limit");
    }

    const body = {
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: TREASURY_ASSET_ID,
      depositType: "CONFIDENTIAL_INTENTS",
      destinationAsset: input.destinationAsset,
      amount: input.amount,
      recipient: input.recipient,
      recipientType: input.recipientType,
      refundTo: input.refundTo,
      refundType: "CONFIDENTIAL_INTENTS",
      deadline: input.deadline.toISOString(),
    };
    const check = (response: QuoteResponse, dry: boolean) => {
      if (!verifyQuoteSignature(response, quotePublicKey)) {
        throw new QuoteGuardError("1Click's quote signature doesn't verify");
      }
      const q = response.quoteRequest;
      for (const key of Object.keys(body) as (keyof typeof body)[]) {
        if (key === "slippageTolerance") continue;
        if (q[key] !== body[key]) throw new QuoteGuardError(`1Click echoed a different ${key}`);
      }
      if (q.dry !== dry) throw new QuoteGuardError("1Click echoed a different dry flag");
      if (response.quote.amountOut !== input.amount) {
        throw new QuoteGuardError("the quote doesn't deliver the item's amount");
      }
    };

    const dry = await quote({ ...body, dry: true });
    check(dry, true);
    if (input.mode === "simulated") {
      return {
        mode: "simulated",
        amountIn: dry.quote.amountIn,
        minAmountIn: dry.quote.minAmountIn,
        amountOut: dry.quote.amountOut,
        withdrawFee: String(dry.quote.withdrawFee ?? "0"),
        requestedDeadline: input.deadline,
        correlationId: dry.correlationId ?? "",
        raw: dry,
      };
    }
    const live = await quote({ ...body, dry: false });
    check(live, false);
    const { depositAddress, deadline } = live.quote;
    if (!depositAddress || !deadline)
      throw new OneClickError("unexpected", "1Click sent no deposit address");
    return {
      mode: "live",
      depositAddress,
      amountIn: live.quote.amountIn,
      minAmountIn: live.quote.minAmountIn,
      amountOut: live.quote.amountOut,
      withdrawFee: String(live.quote.withdrawFee ?? "0"),
      requestedDeadline: input.deadline,
      quoteDeadline: deadline,
      correlationId: live.correlationId ?? "",
      raw: live,
    };
  }

  return {
    createPayoutQuote: payoutQuote,

    /** Funding: from an external chain into the org's own treasury, and only there. */
    createFundingQuote(input: {
      treasuryAccountId: string;
      recipient: string;
      originAsset: string;
      amount: string;
      refundAddress: string;
      deadline: Date;
    }): Promise<LiveQuote> {
      if (input.recipient !== input.treasuryAccountId) {
        throw new QuoteGuardError("funding must go to the org's own treasury");
      }
      if (!input.refundAddress) throw new QuoteGuardError("funding needs a refund address");
      return dryThenLive(
        {
          swapType: "EXACT_INPUT",
          slippageTolerance: 100,
          originAsset: input.originAsset,
          depositType: "ORIGIN_CHAIN",
          destinationAsset: TREASURY_ASSET_ID,
          amount: input.amount,
          recipient: input.recipient,
          recipientType: "INTENTS",
          refundTo: input.refundAddress,
          refundType: "ORIGIN_CHAIN",
          deadline: input.deadline.toISOString(),
        },
        { recipient: input.recipient, recipientType: "INTENTS", refundTo: input.refundAddress },
      );
    },

    /** Shield: the treasury's public balance into its own confidential balance, and only there. */
    createShieldQuote(input: {
      treasuryAccountId: string;
      recipient: string;
      refundTo: string;
      amount: string;
      deadline: Date;
    }): Promise<LiveQuote> {
      if (input.recipient !== input.treasuryAccountId) {
        throw new QuoteGuardError("shield must go to the org's own treasury");
      }
      if (input.refundTo !== input.treasuryAccountId) {
        throw new QuoteGuardError("a shield refund must go to the org's own treasury");
      }
      return dryThenLive(
        {
          swapType: "EXACT_INPUT",
          slippageTolerance: 100,
          originAsset: TREASURY_ASSET_ID,
          depositType: "INTENTS",
          destinationAsset: TREASURY_ASSET_ID,
          amount: input.amount,
          recipient: input.recipient,
          recipientType: "CONFIDENTIAL_INTENTS",
          refundTo: input.refundTo,
          refundType: "INTENTS",
          deadline: input.deadline.toISOString(),
        },
        {
          recipient: input.recipient,
          recipientType: "CONFIDENTIAL_INTENTS",
          refundTo: input.refundTo,
        },
      );
    },

    generateSwapTransferIntent: async (input: { signerId: string; depositAddress: string }) =>
      (
        await call(generated, "/v0/generate-intent", {
          method: "POST",
          body: {
            type: "swap_transfer",
            standard: "nep413",
            signerId: input.signerId,
            depositAddress: input.depositAddress,
          },
        })
      ).intent.payload,

    submitIntent: (signedData: Nep413SignedData) =>
      call(submitted, "/v0/submit-intent", {
        method: "POST",
        body: { type: "swap_transfer", signedData },
      }),

    status: (depositAddress: string) =>
      call(status, `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
        method: "GET",
      }),

    authenticate: (signedData: Nep413SignedData) =>
      call(tokens, "/v0/auth/authenticate", { method: "POST", body: { signedData } }),

    refresh: (refreshToken: string) =>
      call(refreshed, "/v0/auth/refresh", { method: "POST", body: { refreshToken } }),

    balances: (accessToken: string) =>
      call(balances, "/v0/account/balances", { method: "GET", bearer: accessToken }),
  };
}
