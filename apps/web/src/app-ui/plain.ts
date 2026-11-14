// Plain words for every code the API, 1Click or the checks hand a screen (W7.3). A person never reads
// "needs_session", "PENDING_DEPOSIT" or "destination_not_active": every screen goes through here, and
// a guard test (plain.test.ts) fails on a code that reaches a screen without it. A code with no entry
// still becomes readable words (lower case, no underscores) instead of leaking through as it is.

/** Turns a code the table doesn't know into words: "some_new_code" and "SOME_NEW_CODE" -> "Some new code". */
export function wordsFromCode(code: string): string {
  const spaced = code
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .trim()
    .toLowerCase();
  return spaced ? `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}` : "Unknown";
}

function lookup(table: Readonly<Record<string, string>>, code: string): string {
  return table[code] ?? wordsFromCode(code);
}

/** Why a balance can't be shown, in a sentence that says what to do (never the code). */
export const UNAVAILABLE: Readonly<Record<string, string>> = {
  needs_session: "Connect your wallet to see your private balance.",
  oneclick_error: "NEAR Intents didn't answer. Try again in a moment.",
  rpc_error: "NEAR didn't answer. Try again in a moment.",
};
export function whyUnavailable(reason: string): string {
  return UNAVAILABLE[reason] ?? "Not available right now. Try again in a moment.";
}

/** The word shown in a balance's big number when there is no number. */
export const NO_BALANCE_VALUE = "Not shown yet";

/** What 1Click reports about a funding deposit (the status route's words), for a person. */
export const FUNDING_STATUS: Readonly<Record<string, string>> = {
  PENDING_DEPOSIT: "Waiting for your deposit",
  KNOWN_DEPOSIT_TX: "Your deposit was seen, confirming it",
  PROCESSING: "Processing your deposit",
  SUCCESS: "Done. The funds are in your treasury",
  INCOMPLETE_DEPOSIT: "The deposit was smaller than the quote, so it is being returned",
  REFUNDED: "Returned to your refund address",
  FAILED: "It didn't go through. The money is returned to your refund address",
  AWAITING_SIGNATURE: "Waiting for your signature",
};
export const fundingStatus = (status: string): string => lookup(FUNDING_STATUS, status);

/** A payout attempt's state. */
export const ATTEMPT_STATUS: Readonly<Record<string, string>> = {
  PLANNED: "Planned",
  QUOTED: "Quote ready",
  SIGNED: "Signed",
  SUBMITTED: "Sent",
  PROCESSING: "Processing",
  SUCCESS: "Paid",
  REFUNDED: "Returned",
  FAILED: "Failed",
  EXPIRED: "Quote expired",
};
export const attemptStatus = (status: string): string => lookup(ATTEMPT_STATUS, status);

/** Why a contractor's address can't be paid yet (the registry's reasons). */
export const PAYABLE_REASON: Readonly<Record<string, string>> = {
  ok: "Payable",
  no_active_destination: "No address yet",
  contractor_archived: "Contractor archived",
  superseded_awaiting_new_head: "New address waiting for your approval",
  destination_superseded: "Address replaced",
  destination_not_active: "Address not active yet",
  destination_not_accepted: "Address not accepted yet",
  owner_approval_required: "Needs your approval",
  approval_signer_not_treasury: "Approval signed by the wrong wallet",
  approval_revoked: "Approval withdrawn",
  approval_expired: "Approval expired",
  not_in_registry_head: "Not on the signed payee list yet",
};
export const payableReason = (code: string): string => lookup(PAYABLE_REASON, code);

/** A pay-run check, as a person reads it. */
export const REVIEW_FLAG: Readonly<Record<string, string>> = {
  contractor_archived: "This contractor is archived",
  superseded_awaiting_new_head: "A new address is waiting for your approval",
  destination_not_payable: "This address can't be paid yet",
  fee_preview_unavailable: "The fee couldn't be shown. Try again",
  address_recently_changed: "The address was changed recently",
  not_contractor_confirmed: "The contractor hasn't confirmed this address",
  new_destination_since_last_paid: "A new address since the last payment",
  first_payment: "First payment to this person",
  amount_deviation: "The amount differs from the last payment",
};
export function reviewFlag(flag: { code: string; detail?: string | undefined }): string {
  // A "can't be paid yet" check carries the registry's reason as its detail: say that instead.
  if (flag.code === "destination_not_payable" && flag.detail && PAYABLE_REASON[flag.detail])
    return PAYABLE_REASON[flag.detail] as string;
  if (flag.detail && !/^[a-z]+(_[a-z]+)+$/.test(flag.detail) && REVIEW_FLAG[flag.code])
    return `${REVIEW_FLAG[flag.code]}: ${flag.detail}`;
  return lookup(REVIEW_FLAG, flag.code);
}

/** A contractor's or an address's own state. */
export const RECORD_STATUS: Readonly<Record<string, string>> = {
  active: "Active",
  archived: "Archived",
  invited: "Invited",
  pending: "Waiting",
  candidate: "Waiting for approval",
  superseded: "Replaced",
};
export const recordStatus = (status: string): string => lookup(RECORD_STATUS, status);

/** The status NEAR Intents recorded for a private payout, when a payslip shows it. */
export const privatePayoutStatus = (status: string): string => attemptStatus(status);
