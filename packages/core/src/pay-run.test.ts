import { describe, expect, it } from "vitest";
import { InvalidTransitionError, ModeMismatchError } from "./errors.js";
import { money, USDC } from "./money.js";
import {
  derivePayRunStatus,
  PAY_RUN_STATUSES,
  PAY_RUN_TRANSITIONS,
  transitionPayRun,
  type PayRun,
  type PayRunItem,
  type PayRunStatus,
} from "./pay-run.js";
import type { AttemptStatus, PayoutAttempt } from "./payout-attempt.js";

const run = (status: PayRunStatus): PayRun => ({ id: "run-1", status, mode: "simulated" });

const ALLOWED: readonly (readonly [PayRunStatus, PayRunStatus])[] = [
  ["Draft", "Prepared"],
  ["Prepared", "InReview"],
  ["InReview", "Quoting"],
  ["Quoting", "Signing"],
  ["Signing", "Settling"],
  ["Signing", "Quoting"],
  ["Settling", "Completed"],
  ["Settling", "PartiallyCompleted"],
  ["PartiallyCompleted", "Quoting"],
];

describe("transition table", () => {
  it("has exactly the moves in the §6.3 diagram", () => {
    const table = PAY_RUN_STATUSES.flatMap((from) =>
      PAY_RUN_TRANSITIONS[from].map((to) => `${from}->${to}`),
    );
    expect(table.sort()).toEqual(ALLOWED.map(([from, to]) => `${from}->${to}`).sort());
  });

  it.each(ALLOWED)("allows %s -> %s", (from, to) => {
    expect(transitionPayRun(run(from), to).status).toBe(to);
  });

  const disallowed = PAY_RUN_STATUSES.flatMap((from) =>
    PAY_RUN_STATUSES.filter((to) => !PAY_RUN_TRANSITIONS[from].includes(to)).map(
      (to) => [from, to] as const,
    ),
  );

  it.each(disallowed)("rejects %s -> %s with a typed error", (from, to) => {
    let caught: unknown;
    try {
      transitionPayRun(run(from), to);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    expect(caught).toMatchObject({ machine: "pay_run", from, to });
  });

  it("keeps the mode and leaves the original unchanged", () => {
    const original = run("Draft");
    const next = transitionPayRun(original, "Prepared");
    expect(next.mode).toBe("simulated");
    expect(original.status).toBe("Draft");
  });
});

const AT = new Date("2026-11-06T10:00:00.000Z");

function attempt(
  status: AttemptStatus,
  attemptNo = 1,
  history: readonly AttemptStatus[] = [status],
): PayoutAttempt {
  return {
    lineItemId: "item",
    attemptNo,
    status,
    mode: "simulated",
    statusHistory: history.map((s) => ({ status: s, at: AT })),
  };
}

function item(...attempts: PayoutAttempt[]): PayRunItem {
  return { id: "item", mode: "simulated", amount: money(USDC, 1n), attempts };
}

const single = (...statuses: AttemptStatus[]) => statuses.map((s) => item(attempt(s)));

describe("derivePayRunStatus", () => {
  it("returns null with no items", () => {
    expect(derivePayRunStatus([])).toBeNull();
  });

  it("returns null when no item has an attempt, as people decide those stages", () => {
    expect(derivePayRunStatus([item(), item()])).toBeNull();
  });

  it.each<[string, AttemptStatus[], PayRunStatus]>([
    ["one PLANNED", ["PLANNED"], "Quoting"],
    ["PLANNED beside QUOTED", ["PLANNED", "QUOTED"], "Quoting"],
    ["PLANNED beside SUCCESS", ["PLANNED", "SUCCESS"], "Quoting"],
    ["all QUOTED", ["QUOTED", "QUOTED"], "Signing"],
    ["QUOTED beside SIGNED", ["QUOTED", "SIGNED"], "Signing"],
    ["QUOTED beside SUBMITTED", ["QUOTED", "SUBMITTED"], "Signing"],
    ["SIGNED beside SUCCESS", ["SIGNED", "SUCCESS"], "Signing"],
    ["all SUBMITTED", ["SUBMITTED", "SUBMITTED"], "Settling"],
    ["SUBMITTED beside PROCESSING", ["SUBMITTED", "PROCESSING"], "Settling"],
    ["PROCESSING beside SUCCESS", ["PROCESSING", "SUCCESS"], "Settling"],
    ["PROCESSING beside FAILED", ["PROCESSING", "FAILED"], "Settling"],
    ["all SUCCESS", ["SUCCESS", "SUCCESS"], "Completed"],
    ["SUCCESS beside FAILED", ["SUCCESS", "FAILED"], "PartiallyCompleted"],
    ["SUCCESS beside REFUNDED", ["SUCCESS", "REFUNDED"], "PartiallyCompleted"],
    ["SUCCESS beside EXPIRED", ["SUCCESS", "EXPIRED"], "PartiallyCompleted"],
    ["all FAILED", ["FAILED", "FAILED"], "PartiallyCompleted"],
    ["all EXPIRED before any submit", ["EXPIRED", "EXPIRED"], "Quoting"],
    ["EXPIRED beside QUOTED", ["EXPIRED", "QUOTED"], "Quoting"],
    ["EXPIRED beside SIGNED", ["EXPIRED", "SIGNED"], "Quoting"],
    ["EXPIRED beside PROCESSING", ["EXPIRED", "PROCESSING"], "Settling"],
  ])("%s", (_label, statuses, expected) => {
    expect(derivePayRunStatus(single(...statuses))).toBe(expected);
  });

  it("an item with no attempt beside others is Quoting", () => {
    expect(derivePayRunStatus([item(), item(attempt("SUCCESS"))])).toBe("Quoting");
  });

  it("uses each item's latest attempt, whatever the array order", () => {
    const retried = item(attempt("SUCCESS", 2), attempt("FAILED", 1));
    expect(derivePayRunStatus([retried])).toBe("Completed");
  });

  it("follows a retry: a failed run re-enters Quoting, then completes", () => {
    const paid = item(attempt("SUCCESS"));
    expect(derivePayRunStatus([paid, item(attempt("FAILED"))])).toBe("PartiallyCompleted");
    expect(derivePayRunStatus([paid, item(attempt("FAILED"), attempt("PLANNED", 2))])).toBe(
      "Quoting",
    );
    expect(derivePayRunStatus([paid, item(attempt("FAILED"), attempt("QUOTED", 2))])).toBe(
      "Signing",
    );
    expect(derivePayRunStatus([paid, item(attempt("FAILED"), attempt("PROCESSING", 2))])).toBe(
      "Settling",
    );
    expect(derivePayRunStatus([paid, item(attempt("FAILED"), attempt("SUCCESS", 2))])).toBe(
      "Completed",
    );
  });

  it("reconciliation doesn't change the derived status", () => {
    const at = new Date("2026-11-06T10:00:00.000Z");
    const success = { ...attempt("SUCCESS"), reconciledAt: at };
    const refunded = { ...attempt("REFUNDED"), reconciledAt: at };
    expect(derivePayRunStatus([item(success)])).toBe("Completed");
    expect(derivePayRunStatus([item(refunded)])).toBe("PartiallyCompleted");
  });

  it("refuses to mix live and simulated items", () => {
    const live: PayRunItem = { ...item(attempt("SUCCESS")), mode: "live" };
    expect(() => derivePayRunStatus([item(attempt("SUCCESS")), live])).toThrow(ModeMismatchError);
  });

  it("refuses to mix live and simulated attempts", () => {
    const live: PayoutAttempt = { ...attempt("SUCCESS"), mode: "live" };
    expect(() => derivePayRunStatus([item(attempt("SUCCESS")), item(live)])).toThrow(
      ModeMismatchError,
    );
  });
});
