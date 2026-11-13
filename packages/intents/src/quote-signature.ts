// 1Click quote signatures (S-C, server-side gate A). The algorithm follows the official SDK,
// @defuse-protocol/one-click-sdk-typescript 0.1.26 (buildSignedQuoteRequest, buildSignedQuote,
// hashQuote, verifyQuoteSignature), reimplemented here because the SDK isn't a dependency (L5, L14).
// The key isn't in the docs, only in the SDK, and S-C verified it against 16 recorded quotes.
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

/** Versioned, so a rotation is a reviewed change. Override with ONECLICK_QUOTE_PUBLIC_KEY. */
export const ONECLICK_QUOTE_KEY = {
  version: "v1 (SDK 0.1.26, verified in S-C on 2026-11-05)",
  publicKey: "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc",
} as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };

/** json-stable-stringify 1.3.0's output: sorted keys, undefined object members dropped. */
export function stableStringify(value: Json | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v) ?? "null").join(",")}]`;
  }
  const parts = Object.keys(value)
    .sort()
    .flatMap((key) => {
      const member = stableStringify(value[key]);
      return member === undefined ? [] : [`${JSON.stringify(key)}:${member}`];
    });
  return `{${parts.join(",")}}`;
}

export type SignedQuoteResponse = {
  quote: Record<string, any>;
  quoteRequest: Record<string, any>;
  timestamp?: string;
  signature?: string;
};

const orUndefined = <T>(value: T) => (value ? value : undefined);

/**
 * The signed fields, exactly as the SDK picks them. Fields outside this list aren't signed, so the
 * browser gate reads only these (unsigned appFees, confidentiality, insured, depositMode never count).
 */
export function signedQuoteFields(response: SignedQuoteResponse): Record<string, Json | undefined> {
  const r = response.quoteRequest;
  const q = response.quote;
  const request = {
    dry: r.dry,
    swapType: r.swapType,
    slippageTolerance: r.slippageTolerance,
    originAsset: r.originAsset,
    depositType: r.depositType,
    destinationAsset: r.destinationAsset,
    amount: r.amount,
    refundTo: r.refundTo,
    refundType: r.refundType,
    recipient: r.recipient,
    recipientType: r.recipientType,
    deadline: r.deadline,
    quoteWaitingTimeMs: orUndefined(r.quoteWaitingTimeMs),
    referral: orUndefined(r.referral),
    virtualChainRecipient: orUndefined(r.virtualChainRecipient),
    virtualChainRefundRecipient: orUndefined(r.virtualChainRefundRecipient),
    customRecipientMsg: orUndefined(r.customRecipientMsg),
  };
  const base = {
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountInUsd: q.amountInUsd,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    minAmountOut: q.minAmountOut,
  };
  const quote = r.dry
    ? base
    : {
        ...base,
        depositAddress: orUndefined(q.depositAddress),
        depositMemo: orUndefined(q.depositMemo),
        deadline: orUndefined(q.deadline),
        timeWhenInactive: orUndefined(q.timeWhenInactive),
        timeEstimate: orUndefined(q.timeEstimate),
        refundFee: orUndefined(q.refundFee),
        withdrawFee: orUndefined(q.withdrawFee),
      };
  return { ...request, ...quote, timestamp: response.timestamp };
}

/** Base58 of SHA-256 over the stable JSON. Its UTF-8 text is what 1Click signs. */
export function oneClickQuoteHash(response: SignedQuoteResponse): string {
  const text = stableStringify(signedQuoteFields(response) as Json) as string;
  return base58.encode(sha256(new TextEncoder().encode(text)));
}

export function verifyQuoteSignature(
  response: SignedQuoteResponse,
  publicKey: string = ONECLICK_QUOTE_KEY.publicKey,
): boolean {
  try {
    const strip = (v: string) => (v.startsWith("ed25519:") ? v.slice(8) : v);
    if (!response.signature) return false;
    return ed25519.verify(
      base58.decode(strip(response.signature)),
      new TextEncoder().encode(oneClickQuoteHash(response)),
      base58.decode(strip(publicKey)),
    );
  } catch {
    return false;
  }
}
