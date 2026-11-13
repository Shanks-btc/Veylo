// The browser gate before any payout signature (ARCHITECTURE §6.3, T-2): A, the signing deadline,
// B, B2 and C, for every item. The only authority for enabling signing is `allPassed` (L41).
import type { payRunItem, payeeRegistryResponse, signRequestResponse } from "@veylo/contract";
import {
  checkNearSpend,
  getPayoutRoute,
  parseAmount,
  TREASURY_ASSET_ID,
  USDC,
  type PayoutRoute,
  type PayoutRouteId,
} from "@veylo/core";
import {
  CONFIDENTIAL_TOKEN_PREFIX,
  CONFIDENTIAL_VERIFIER,
  isPinnedVerifier,
  parseEd25519PublicKey,
  shieldPayloadProblem,
} from "@veylo/intents";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { z } from "zod";
import type { HighWaterStore } from "./high-water.js";
import { payeeForItem, verifyRegistry, type VerifiedRegistry } from "./registry.js";
import type { GateRpc } from "./rpc.js";
import { gateA, gateDeadline, readSignedQuote, type SignedQuote } from "./signed-quote.js";
import {
  fail,
  guarded,
  pass,
  type GateReport,
  type GateResult,
  type ItemGateReport,
} from "./types.js";

export * from "./types.js";
export {
  createIndexedDbHighWater,
  createMemoryHighWater,
  StorageUnavailable,
} from "./high-water.js";
export type { HighWaterStore } from "./high-water.js";
export { createGateRpc, type GateRpc } from "./rpc.js";
export { PINNED_ONECLICK_QUOTE_KEY, signingBound } from "./signed-quote.js";

type Item = z.infer<typeof payRunItem>;
type SignRequest = z.infer<typeof signRequestResponse>;
type Registry = z.infer<typeof payeeRegistryResponse>;

const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

/**
 * Most an item's signed amount may exceed what it delivers: max(1 USDC, 1% of the payout) (L45).
 * Fees vary by route and time (D6); this bounds an inflated amount, it isn't a fee estimate.
 */
export function maxFeeUnits(amountOut: bigint): bigint {
  const pct = amountOut / 100n;
  return pct > 1_000_000n ? pct : 1_000_000n;
}

/** Gate C's fee rule: the signed amount covers the payout and exceeds it by at most the ceiling. */
export function feeWithinBound(amountIn: bigint, payoutUnits: bigint): boolean {
  return amountIn >= payoutUnits && amountIn - payoutUnits <= maxFeeUnits(payoutUnits);
}

/**
 * B2: the wallet's signing key is registered for the treasury on the verifier the payload names
 * (its NEP-413 recipient). Only the pinned verifiers, intents.near and intents.far, are accepted.
 */
export async function gateB2(input: {
  treasuryAccountId: string;
  walletPublicKey: string;
  /** The verifier the payload being signed is for: payload.recipient. */
  verifier: string;
  rpc: GateRpc;
}): Promise<GateResult> {
  return guarded("B2", async () => {
    if (!isPinnedVerifier(input.verifier))
      return fail("B2", `the payload is for an unknown verifier: ${input.verifier}`);
    const key = parseEd25519PublicKey(input.walletPublicKey);
    if (!key) return fail("B2", "the wallet's public key is malformed");
    // An implicit account's own key is its account: no registration needed (§6.3).
    if (
      IMPLICIT_ACCOUNT.test(input.treasuryAccountId) &&
      bytesToHex(key) === input.treasuryAccountId
    ) {
      return pass("B2");
    }
    const registered = await input.rpc.hasPublicKey(
      input.verifier,
      input.treasuryAccountId,
      input.walletPublicKey,
    );
    return registered
      ? pass("B2")
      : fail("B2", `the wallet's key isn't registered for the treasury on ${input.verifier}`);
  });
}

/** B for one item: the signed quote pays exactly the owner-signed payee for its destination. */
export function gateB(
  registry: VerifiedRegistry,
  item: Item,
  quote: unknown,
  now: Date,
): GateResult {
  if (!registry.ok) return fail("B", registry.reason);
  const signed = readSignedQuote(quote);
  if (!signed) return fail("B", "no verified quote");
  const found = payeeForItem(registry, item, now);
  if (!found.ok) return fail("B", found.reason);
  const { record } = found.payee;
  const route = getPayoutRoute(record.routeId as PayoutRouteId);
  if (signed.recipient !== record.recipient) return fail("B", "the quote pays another recipient");
  if (signed.recipientType !== record.recipientType)
    return fail("B", "the quote's recipient type differs");
  if (signed.destinationAsset !== route.assetId)
    return fail("B", "the quote pays on another route");
  return pass("B");
}

/**
 * C for one item: the quote delivers exactly the item's amount to its payee, refunds go back to
 * the treasury, and the payload the wallet signs is one transfer of exactly the quoted amount to
 * the quote's deposit address, from the treasury, on the confidential verifier.
 */
export function gateC(input: {
  item: Item;
  quote: unknown;
  payload: SignRequest["payload"];
  treasuryAccountId: string;
  saltHex: string;
  /** The verified payee's route. NEAR payouts (W6) are sized in NEAR from the approved USD amount. */
  route?: PayoutRoute | undefined;
}): GateResult {
  const signed = readSignedQuote(input.quote);
  if (!signed) return fail("C", "no verified quote");
  return gateCSigned(signed, input);
}

/** Gate C's checks on the signed fields, after the signature has verified (see gateC). */
export function gateCSigned(
  signed: SignedQuote,
  input: Omit<Parameters<typeof gateC>[0], "quote">,
): GateResult {
  const itemUnits = parseAmount(input.item.amount, USDC).units;
  const near = input.route?.asset === "NEAR";
  if (near) {
    // The item is a USD amount. The quote delivers an exact NEAR amount (EXACT_OUTPUT) to the
    // payee, and what the treasury spends must be the approved USD or a little more (the fee).
    if (signed.destinationAsset !== input.route?.assetId)
      return fail("C", "the quote pays another asset than the payee's route");
    if (signed.amountOut !== signed.amount)
      return fail("C", "the quote doesn't deliver its own exact NEAR amount");
    const spend = checkNearSpend(BigInt(signed.amountIn), itemUnits);
    if (!spend.ok) return fail("C", spend.reason);
  } else if (BigInt(signed.amountOut) !== itemUnits || BigInt(signed.amount) !== itemUnits) {
    return fail("C", "the quote doesn't deliver exactly the item's amount");
  }
  if (signed.originAsset !== TREASURY_ASSET_ID) return fail("C", "the quote spends another asset");
  if (signed.refundTo !== input.treasuryAccountId) return fail("C", "refunds would go elsewhere");
  if (signed.refundType !== "CONFIDENTIAL_INTENTS")
    return fail("C", "refunds wouldn't stay confidential");
  const amountIn = BigInt(signed.amountIn);
  if (!near) {
    if (amountIn < itemUnits) return fail("C", "the signed amount is below the payout");
    if (!feeWithinBound(amountIn, itemUnits)) return fail("C", "the fee is above the bound");
  }
  if (input.payload.recipient !== CONFIDENTIAL_VERIFIER) {
    // Direct NEAR payouts (intents.near) wait on spike S-N; nothing else is a payout verifier.
    return fail("C", `payouts on ${input.payload.recipient} aren't enabled (spike S-N pending)`);
  }
  const problem = shieldPayloadProblem(input.payload, {
    signerId: input.treasuryAccountId,
    depositAddress: signed.depositAddress,
    tokenId: `${CONFIDENTIAL_TOKEN_PREFIX}${signed.originAsset}`,
    amount: signed.amountIn,
    verifier: CONFIDENTIAL_VERIFIER,
    saltHex: input.saltHex,
  });
  if (problem) return fail("C", `the payload to sign is wrong: ${problem}`);
  return pass("C");
}

/**
 * Runs every gate on every item. Never throws: any error becomes a FAIL for the gates it touches.
 * The treasury account and wallet key are what the connected wallet reports, never API values.
 */
export async function runGates(input: {
  orgId: string;
  treasuryAccountId: string;
  walletPublicKey: string;
  authRecipient: string;
  deadlineMinutes: number;
  registry: Registry | undefined;
  items: readonly { item: Item; signRequest: SignRequest | undefined }[];
  rpc: GateRpc;
  highWater: HighWaterStore;
  now: Date;
}): Promise<GateReport> {
  const { now } = input;
  let registry: VerifiedRegistry;
  try {
    registry = input.registry
      ? await verifyRegistry({ ...input, registry: input.registry })
      : { ok: false, reason: "no payee registry" };
  } catch (err) {
    registry = {
      ok: false,
      reason: `registry check failed: ${err instanceof Error ? err.message : "error"}`,
    };
  }
  let saltHex: string | undefined;
  let saltError = "salt not read";
  try {
    saltHex = await input.rpc.currentSalt(CONFIDENTIAL_VERIFIER);
  } catch (err) {
    saltError = `NEAR RPC: ${err instanceof Error ? err.message : "error"}`;
  }

  const items: ItemGateReport[] = [];
  for (const { item, signRequest } of input.items) {
    const quote = signRequest?.gate.quote;
    const found = registry.ok ? payeeForItem(registry, item, now) : undefined;
    const route =
      found && found.ok ? getPayoutRoute(found.payee.record.routeId as PayoutRouteId) : undefined;
    const gates: GateResult[] = signRequest
      ? [
          await guarded("A", () => gateA(quote)),
          await guarded("deadline", () => gateDeadline(quote, input.deadlineMinutes, now)),
          await guarded("B", () => gateB(registry, item, quote, now)),
          await gateB2({ ...input, verifier: signRequest.payload.recipient }),
          await guarded("C", () =>
            saltHex
              ? gateC({
                  item,
                  quote,
                  payload: signRequest.payload,
                  treasuryAccountId: input.treasuryAccountId,
                  saltHex,
                  route,
                })
              : fail("C", saltError),
          ),
        ]
      : (["A", "deadline", "B", "B2", "C"] as const).map((g) => fail(g, "no sign request"));
    items.push({ itemId: item.id, gates, passed: gates.every((g) => g.passed) });
  }
  return { items, allPassed: items.length > 0 && items.every((i) => i.passed) };
}
