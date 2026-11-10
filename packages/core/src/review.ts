import type { PayableReason } from "./payee.js";

/** A flag either blocks approval or is shown to the owner for judgement. */
export type ReviewFlag = {
  readonly code:
    | "destination_not_payable"
    | "superseded_awaiting_new_head"
    | "contractor_archived"
    | "fee_preview_unavailable"
    | "not_contractor_confirmed"
    | "new_destination_since_last_paid"
    | "first_payment"
    | "amount_deviation";
  readonly blocking: boolean;
  readonly detail?: string;
};

export const DEFAULT_DEVIATION_PERCENT = 25;

/** Pure: everything is passed in, so the same rules can run in the browser later. */
export function reviewFlags(input: {
  contractorStatus: string;
  /** null when the contractor has no active destination. */
  destination: {
    id: string;
    enteredBy: "owner" | "contractor";
    contractorConfirmedAt: Date | null;
  } | null;
  payable: { payable: boolean; payableReason: PayableReason | "no_active_destination" };
  /** The contractor's last successful live payout, if any. */
  lastPaid: { destinationId: string; amount: bigint } | undefined;
  amount: bigint;
  deviationPercent: number;
  feePreviewFailed: boolean;
}): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const { payableReason } = input.payable;

  if (input.contractorStatus !== "active") {
    flags.push({ code: "contractor_archived", blocking: true });
  }
  if (payableReason === "superseded_awaiting_new_head") {
    flags.push({ code: "superseded_awaiting_new_head", blocking: true });
  } else if (!input.payable.payable && payableReason !== "contractor_archived") {
    flags.push({ code: "destination_not_payable", blocking: true, detail: payableReason });
  }
  if (input.payable.payable && input.feePreviewFailed) {
    flags.push({ code: "fee_preview_unavailable", blocking: true });
  }

  const d = input.destination;
  if (d && d.enteredBy === "owner" && d.contractorConfirmedAt === null) {
    flags.push({ code: "not_contractor_confirmed", blocking: false });
  }
  if (!input.lastPaid) {
    flags.push({ code: "first_payment", blocking: false });
  } else {
    if (d && d.id !== input.lastPaid.destinationId) {
      flags.push({ code: "new_destination_since_last_paid", blocking: false });
    }
    const last = input.lastPaid.amount;
    const diff = input.amount > last ? input.amount - last : last - input.amount;
    // Integer arithmetic: diff / last > percent / 100.
    if (last > 0n && diff * 100n > BigInt(input.deviationPercent) * last) {
      flags.push({
        code: "amount_deviation",
        blocking: false,
        detail: `${last.toString()} last time`,
      });
    }
  }
  return flags;
}

export const hasBlockingFlag = (flags: readonly ReviewFlag[]): boolean =>
  flags.some((f) => f.blocking);
