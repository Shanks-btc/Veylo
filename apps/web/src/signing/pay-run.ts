// Pay run signing, as the review screen shows it (ARCHITECTURE §6.3, L35, L41). The browser gate
// module's `allPassed` is the only thing that can enable signing: everything here can only keep the
// button disabled (still checking, already signing, past the deadline), never enable it.
import { base64 } from "@scure/base";
import type { payRunItem, signRequestResponse } from "@veylo/contract";
import type { z } from "zod";
import type { ApiClient } from "../api/client";
import type { GateName, GateReport } from "../gates/types";
import { readSignedQuote, signingBound } from "../gates/signed-quote";
import type { CheckItem } from "../ui/data";
import type { WalletSigner } from "../wallet/types";

type Item = z.infer<typeof payRunItem>;
type SignRequest = z.infer<typeof signRequestResponse>;

/** The four gates of the brief (A, B, B2, C), then the signing deadline (L35). */
export const GATE_LABELS: readonly { gate: GateName; label: string }[] = [
  { gate: "A", label: "Quote signed by NEAR Intents" },
  { gate: "B", label: "Payee on the signed list" },
  { gate: "B2", label: "Account key matches" },
  { gate: "C", label: "Amount matches exactly" },
  { gate: "deadline", label: "Time left to sign" },
];

/**
 * A failed check in plain words, for the person signing. The technical reason stays alongside it.
 * Unknown reasons fall back to the technical text alone: nothing is ever hidden or softened.
 */
export function plainReason(gate: GateName, reason: string): string | undefined {
  const r = reason.toLowerCase();
  switch (gate) {
    case "A":
      return /signature/.test(r)
        ? "This quote doesn't carry a valid NEAR Intents signature, so it may have been changed after NEAR Intents signed it."
        : undefined;
    case "B":
      if (/another recipient|another route|recipient type/.test(r))
        return "The quote pays someone who isn't on your signed payee list.";
      if (/no owner-signed payee/.test(r))
        return "This person has no address signed by your treasury wallet yet.";
      if (/expired/.test(r)) return "The signed approval for this address has expired.";
      if (/superseded|more than one/.test(r))
        return "This person's address changed and the new one isn't signed yet.";
      if (/head|approval|hash|rollback|registry|record|doesn't verify|not signed/.test(r))
        return "The payee list your server sent isn't the one your treasury wallet signed. An address may have been swapped.";
      return undefined;
    case "B2":
      return "Your wallet's signing key isn't registered for the treasury, or couldn't be checked.";
    case "C":
      if (/exactly|amount/.test(r))
        return "The amount in the quote isn't the amount on this pay run.";
      if (/refund/.test(r)) return "Refunds wouldn't come back to your treasury.";
      if (/fee/.test(r)) return "The fees are above the allowed ceiling.";
      if (/payload/.test(r)) return "What your wallet would sign doesn't match the quote.";
      return undefined;
    case "deadline":
      return "There isn't enough time left to sign this quote safely.";
  }
}

/** One row per gate across every item: PASS only when every item passed it. */
export function checklist(
  report: GateReport | undefined,
  names: ReadonlyMap<string, string> = new Map(),
): CheckItem[] {
  return GATE_LABELS.map(({ gate, label }) => {
    if (!report || report.items.length === 0) return { id: gate, label, state: "pending" };
    for (const item of report.items) {
      const g = item.gates.find((x) => x.gate === gate);
      if (!g || !g.passed) {
        const who = names.get(item.itemId) ?? "a payout";
        const tech = g?.reason ?? "not checked";
        const plain = plainReason(gate, tech);
        return {
          id: gate,
          label,
          state: "fail",
          reason: plain ? `${who}: ${plain} (${tech})` : `${who}: ${tech}`,
        };
      }
    }
    return { id: gate, label, state: "pass" };
  });
}

export type SignState = {
  report: GateReport | undefined;
  checking: boolean;
  signing: boolean;
  /** The earliest signing bound has passed (L35). */
  expired: boolean;
  /** Warned payouts the owner hasn't ticked "I've checked this" on yet (D5). */
  unacknowledged?: number;
};

/** The warnings a payout can carry, in plain words. */
export function flagText(code: string, detail?: string): string {
  switch (code) {
    case "first_payment":
      return "First payout to this person.";
    case "new_destination_since_last_paid":
      return "This person's payout address changed since their last payout.";
    case "amount_deviation":
      return `The amount is far from their last payout${detail ? ` (${detail})` : ""}.`;
    case "not_contractor_confirmed":
      return "The contractor hasn't confirmed this address.";
    default:
      return code.replaceAll("_", " ");
  }
}

/** Sign is enabled only when the gate module says every gate on every item passed. */
export function canSign(state: SignState): boolean {
  if (!state.report || state.report.allPassed !== true) return false;
  if ((state.unacknowledged ?? 0) > 0) return false;
  return !state.checking && !state.signing && !state.expired;
}

/** The earliest moment any item's quote stops being signable, from its signed timestamp (L35). */
export function earliestSigningBound(
  signRequests: readonly (SignRequest | undefined)[],
  deadlineMinutes: number,
): Date | undefined {
  let earliest: Date | undefined;
  for (const r of signRequests) {
    const signed = r && readSignedQuote(r.gate.quote);
    if (!signed) continue;
    const bound = signingBound(signed, deadlineMinutes);
    if (!earliest || bound < earliest) earliest = bound;
  }
  return earliest;
}

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningError";
  }
}

/**
 * Signs every gated item's payload and sends each signature. Each signature must come from the
 * treasury account and the key gate B2 checked; any other signer stops before anything is sent.
 */
export async function signPayRun(input: {
  api: ApiClient;
  wallet: WalletSigner;
  orgId: string;
  payRunId: string;
  treasuryAccountId: string;
  walletPublicKey: string;
  report: GateReport;
  items: readonly { item: Item; signRequest: SignRequest }[];
  onProgress?: (done: number, total: number) => void;
}): Promise<{ submitted: number }> {
  if (!input.report.allPassed) throw new SigningError("the browser checks haven't all passed");
  const passed = new Set(input.report.items.filter((i) => i.passed).map((i) => i.itemId));
  let done = 0;
  for (const { item, signRequest } of input.items) {
    if (!passed.has(item.id)) throw new SigningError("an item wasn't checked");
    const { payload } = signRequest;
    const signed = await input.wallet.signMessage({
      message: payload.message,
      recipient: payload.recipient,
      nonce: base64.decode(payload.nonce),
    });
    if (signed.accountId !== input.treasuryAccountId)
      throw new SigningError("the wallet signed as another account");
    if (signed.publicKey !== input.walletPublicKey)
      throw new SigningError("the wallet signed with a key the checks didn't cover");
    await input.api.call(
      "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request/:requestId/complete",
      {
        params: {
          orgId: input.orgId,
          payRunId: input.payRunId,
          itemId: item.id,
          requestId: signRequest.requestId,
        },
        body: {
          accountId: signed.accountId,
          publicKey: signed.publicKey,
          signature: signed.signature,
        },
      },
    );
    done += 1;
    input.onProgress?.(done, input.items.length);
  }
  return { submitted: done };
}
