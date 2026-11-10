import { InvalidTransitionError } from "./errors.js";
import { assertSameMode, type HasMode } from "./mode.js";
import type { Money } from "./money.js";
import { attemptOutcome, type AttemptStatus, type PayoutAttempt } from "./payout-attempt.js";

export const PAY_RUN_STATUSES = [
  "Draft",
  "Prepared",
  "InReview",
  "Quoting",
  "Signing",
  "Settling",
  "Completed",
  "PartiallyCompleted",
] as const;

export type PayRunStatus = (typeof PAY_RUN_STATUSES)[number];

/** ARCHITECTURE §6.3, exactly as drawn. */
export const PAY_RUN_TRANSITIONS: Readonly<Record<PayRunStatus, readonly PayRunStatus[]>> = {
  Draft: ["Prepared"],
  Prepared: ["InReview"],
  InReview: ["Quoting"],
  Quoting: ["Signing"],
  Signing: ["Settling", "Quoting"],
  Settling: ["Completed", "PartiallyCompleted"],
  Completed: [],
  PartiallyCompleted: ["Quoting"],
};

export type PayRun = HasMode & {
  readonly id: string;
  readonly status: PayRunStatus;
};

export type PayRunItem = HasMode & {
  readonly id: string;
  readonly amount: Money;
  /** Every attempt for this line item. */
  readonly attempts: readonly PayoutAttempt[];
};

export function transitionPayRun(run: PayRun, to: PayRunStatus): PayRun {
  if (!PAY_RUN_TRANSITIONS[run.status].includes(to)) {
    throw new InvalidTransitionError("pay_run", run.status, to);
  }
  return Object.freeze({ ...run, status: to });
}

function latestAttempt(item: PayRunItem): PayoutAttempt | undefined {
  return [...item.attempts].sort((a, b) => b.attemptNo - a.attemptNo)[0];
}

const NOT_YET_SUBMITTED: readonly AttemptStatus[] = ["PLANNED", "QUOTED", "SIGNED", "EXPIRED"];

/**
 * Derives a run's status from its items' latest attempts.
 *
 * Returns null when no item has an attempt: Draft, Prepared and InReview are decided by people and
 * can't be read from attempts. Otherwise, in order:
 *
 * 1. Any item with no attempt yet, or whose latest attempt is PLANNED: Quoting.
 * 2. Any latest attempt EXPIRED while no item has reached SUBMITTED, so quotes lapsed before
 *    signing finished: Quoting (§6.3, "quotes expired before signing").
 * 3. Any latest attempt QUOTED or SIGNED: Signing.
 * 4. Any latest attempt SUBMITTED or PROCESSING: Settling.
 * 5. All successful: Completed. Otherwise, with some refunded, failed or expired: PartiallyCompleted.
 *
 * This reports where the run stands. It doesn't apply a transition: a poller that sees a jump walks
 * it with transitionPayRun, which still enforces the table.
 */
export function derivePayRunStatus(items: readonly PayRunItem[]): PayRunStatus | null {
  if (items.length === 0) return null;
  assertSameMode(items);
  const latest = items.map(latestAttempt);
  if (latest.every((a) => a === undefined)) return null;
  if (latest.some((a) => a === undefined || a.status === "PLANNED")) return "Quoting";

  const attempts = latest as readonly PayoutAttempt[];
  assertSameMode(attempts);
  const statuses = attempts.map((a) => a.status);
  if (statuses.includes("EXPIRED") && statuses.every((s) => NOT_YET_SUBMITTED.includes(s))) {
    return "Quoting";
  }
  if (statuses.includes("QUOTED") || statuses.includes("SIGNED")) return "Signing";
  if (statuses.includes("SUBMITTED") || statuses.includes("PROCESSING")) return "Settling";
  return attempts.every((a) => attemptOutcome(a) === "success")
    ? "Completed"
    : "PartiallyCompleted";
}
