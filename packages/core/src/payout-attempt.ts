import { AttemptInvariantError, InvalidTransitionError, ModeMismatchError } from "./errors.js";
import type { HasMode, Mode } from "./mode.js";

export const ATTEMPT_STATUSES = [
  "PLANNED",
  "QUOTED",
  "SIGNED",
  "SUBMITTED",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
  "EXPIRED",
] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** ARCHITECTURE §6.4 and L18. Any move not listed here throws. A poll may skip PROCESSING. */
export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  PLANNED: ["QUOTED", "FAILED"],
  QUOTED: ["SIGNED", "EXPIRED", "FAILED"],
  SIGNED: ["SUBMITTED", "EXPIRED", "FAILED"],
  SUBMITTED: ["PROCESSING", "SUCCESS", "REFUNDED", "FAILED"],
  PROCESSING: ["SUCCESS", "REFUNDED", "FAILED"],
  SUCCESS: [],
  REFUNDED: [],
  FAILED: [],
  EXPIRED: [],
};

/** The database's partial unique index uses this same set. */
export const TERMINAL_ATTEMPT_STATUSES = [
  "SUCCESS",
  "REFUNDED",
  "FAILED",
  "EXPIRED",
] as const satisfies readonly AttemptStatus[];

export function isTerminal(status: AttemptStatus): boolean {
  return (TERMINAL_ATTEMPT_STATUSES as readonly AttemptStatus[]).includes(status);
}

export const NON_TERMINAL_ATTEMPT_STATUSES = ATTEMPT_STATUSES.filter((s) => !isTerminal(s));

export const FAILURE_REASONS = [
  "quote_rejected",
  "gate_blocked",
  "generate_intent_rejected",
  "submit_rejected",
  "settlement_failed",
  "unknown",
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

/** FAILED and EXPIRED can be retried. REFUNDED only once reconciliation has confirmed the refund. */
export function canRetry(attempt: Pick<PayoutAttempt, "status" | "reconciledAt">): boolean {
  if (attempt.status === "FAILED" || attempt.status === "EXPIRED") return true;
  return attempt.status === "REFUNDED" && attempt.reconciledAt !== undefined;
}

export type StatusChange = { readonly status: AttemptStatus; readonly at: Date };

export type PayoutAttempt = HasMode & {
  readonly lineItemId: string;
  readonly attemptNo: number;
  readonly status: AttemptStatus;
  /** Oldest first. The last entry is the current status. */
  readonly statusHistory: readonly StatusChange[];
  /** Set only when status is FAILED. */
  readonly failureReason?: FailureReason;
  /** When reconciliation finished. A field, not a status (L18). */
  readonly reconciledAt?: Date;
};

/**
 * Returns a new attempt in the target status, or throws InvalidTransitionError.
 * FAILED requires a failureReason, and no other status accepts one.
 */
export function transitionAttempt(
  attempt: PayoutAttempt,
  to: AttemptStatus,
  at: Date,
  failureReason?: FailureReason,
): PayoutAttempt {
  if (!ATTEMPT_TRANSITIONS[attempt.status].includes(to)) {
    throw new InvalidTransitionError("payout_attempt", attempt.status, to);
  }
  if (to === "FAILED" && !FAILURE_REASONS.includes(failureReason as FailureReason)) {
    throw new AttemptInvariantError(
      "ATTEMPT_FAILURE_REASON_REQUIRED",
      "FAILED requires a valid failureReason",
    );
  }
  if (to !== "FAILED" && failureReason !== undefined) {
    throw new AttemptInvariantError(
      "ATTEMPT_FAILURE_REASON_NOT_ALLOWED",
      `${to} cannot have a failureReason`,
    );
  }
  return Object.freeze({
    ...attempt,
    status: to,
    statusHistory: Object.freeze([...attempt.statusHistory, { status: to, at }]),
    ...(failureReason ? { failureReason } : {}),
  });
}

/** Records reconciliation of a settled attempt, once. The status doesn't change. */
/**
 * Reconciliation applies to every terminal outcome that reached 1Click (L36): SUCCESS, REFUNDED, and
 * FAILED in settlement. Never EXPIRED or a rejected submit, which never moved anything.
 */
export function isReconcilable(attempt: Pick<PayoutAttempt, "status" | "failureReason">): boolean {
  return (
    attempt.status === "SUCCESS" ||
    attempt.status === "REFUNDED" ||
    (attempt.status === "FAILED" && attempt.failureReason === "settlement_failed")
  );
}

export function markReconciled(attempt: PayoutAttempt, at: Date): PayoutAttempt {
  if (!isReconcilable(attempt)) {
    throw new AttemptInvariantError(
      "ATTEMPT_NOT_RECONCILABLE",
      `cannot reconcile an attempt in status ${attempt.status}`,
    );
  }
  if (attempt.reconciledAt !== undefined) {
    throw new AttemptInvariantError("ATTEMPT_ALREADY_RECONCILED", "attempt is already reconciled");
  }
  return Object.freeze({ ...attempt, reconciledAt: at });
}

/** The next attempt number for a line item: one above the highest used, starting from 1. */
export function nextAttemptNumber(attempts: readonly Pick<PayoutAttempt, "attemptNo">[]): number {
  return attempts.reduce((highest, a) => Math.max(highest, a.attemptNo), 0) + 1;
}

/** Throws if a line item has more than one attempt that isn't terminal. */
export function assertAtMostOneNonTerminal(attempts: readonly PayoutAttempt[]): void {
  const open = attempts.filter((a) => !isTerminal(a.status));
  if (open.length > 1) {
    throw new AttemptInvariantError(
      "ATTEMPT_MULTIPLE_NON_TERMINAL",
      `line item has ${open.length} non-terminal attempts`,
    );
  }
}

function assertNoNewAttemptBlocked(lineItemId: string, attempts: readonly PayoutAttempt[]): void {
  if (attempts.some((a) => a.lineItemId !== lineItemId)) {
    throw new AttemptInvariantError(
      "ATTEMPT_WRONG_LINE_ITEM",
      "an attempt belongs to another line item",
    );
  }
  assertAtMostOneNonTerminal(attempts);
  if (attempts.some((a) => !isTerminal(a.status))) {
    throw new AttemptInvariantError(
      "ATTEMPT_NON_TERMINAL_EXISTS",
      "cannot create an attempt while a previous one is non-terminal",
    );
  }
}

/** Starts the first attempt for a line item. */
export function createFirstAttempt(input: {
  lineItemId: string;
  mode: Mode;
  at: Date;
  existingAttempts: readonly PayoutAttempt[];
}): PayoutAttempt {
  if (input.existingAttempts.length > 0) {
    throw new AttemptInvariantError(
      "ATTEMPT_ALREADY_EXISTS",
      "line item already has attempts: use createRetryAttempt",
    );
  }
  return plannedAttempt(input.lineItemId, 1, input.mode, input.at);
}

function plannedAttempt(
  lineItemId: string,
  attemptNo: number,
  mode: Mode,
  at: Date,
): PayoutAttempt {
  const first: StatusChange = { status: "PLANNED", at };
  return Object.freeze({
    lineItemId,
    attemptNo,
    mode,
    status: first.status,
    statusHistory: Object.freeze([first]),
  });
}

/**
 * Creates a new attempt after a failed one. An attempt is never reused.
 *
 * Rule 3, "never re-sign without a status check": statusCheckedAt is required, and must not be
 * earlier than the previous attempt's last status change or later than `at`. A retry is refused
 * outright if any earlier attempt on this line item succeeded, which guards against double payment.
 */
export function createRetryAttempt(input: {
  lineItemId: string;
  attempts: readonly PayoutAttempt[];
  statusCheckedAt: Date;
  at: Date;
}): PayoutAttempt {
  const { lineItemId, attempts, statusCheckedAt, at } = input;
  assertNoNewAttemptBlocked(lineItemId, attempts);

  const previous = [...attempts].sort((a, b) => b.attemptNo - a.attemptNo)[0];
  if (!previous) {
    throw new AttemptInvariantError("ATTEMPT_NONE_TO_RETRY", "line item has no attempt to retry");
  }
  const modes = new Set(attempts.map((a) => a.mode));
  if (modes.size > 1) throw new ModeMismatchError("line item mixes live and simulated attempts");
  if (attempts.some((a) => attemptOutcome(a) === "success")) {
    throw new AttemptInvariantError(
      "ATTEMPT_ALREADY_PAID",
      "line item already has a successful attempt",
    );
  }
  if (!canRetry(previous)) {
    throw new AttemptInvariantError(
      "ATTEMPT_NOT_RETRYABLE",
      previous.status === "REFUNDED"
        ? "cannot retry a refund until it is reconciled"
        : `cannot retry from status ${previous.status}`,
    );
  }

  if (!(statusCheckedAt instanceof Date) || Number.isNaN(statusCheckedAt.getTime())) {
    throw new AttemptInvariantError(
      "ATTEMPT_STATUS_CHECK_REQUIRED",
      "statusCheckedAt is required before a retry",
    );
  }
  const lastChange = previous.statusHistory[previous.statusHistory.length - 1];
  if (lastChange && statusCheckedAt.getTime() < lastChange.at.getTime()) {
    throw new AttemptInvariantError(
      "ATTEMPT_STATUS_CHECK_STALE",
      "statusCheckedAt is earlier than the previous attempt's last status change",
    );
  }
  if (statusCheckedAt.getTime() > at.getTime()) {
    throw new AttemptInvariantError(
      "ATTEMPT_STATUS_CHECK_FUTURE",
      "statusCheckedAt is later than the retry",
    );
  }

  return plannedAttempt(lineItemId, nextAttemptNumber(attempts), previous.mode, at);
}

export type AttemptOutcome = "in_flight" | "success" | "refunded" | "failed" | "expired";

/** What finally happened to an attempt. */
export function attemptOutcome(attempt: PayoutAttempt): AttemptOutcome {
  switch (attempt.status) {
    case "SUCCESS":
      return "success";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
    case "EXPIRED":
      return "expired";
    default:
      return "in_flight";
  }
}
