import { describe, expect, it } from "vitest";
import { AttemptInvariantError, InvalidTransitionError, ModeMismatchError } from "./errors.js";
import {
  ATTEMPT_STATUSES,
  ATTEMPT_TRANSITIONS,
  assertAtMostOneNonTerminal,
  attemptOutcome,
  canRetry,
  createFirstAttempt,
  createRetryAttempt,
  FAILURE_REASONS,
  isTerminal,
  markReconciled,
  nextAttemptNumber,
  NON_TERMINAL_ATTEMPT_STATUSES,
  TERMINAL_ATTEMPT_STATUSES,
  transitionAttempt,
  type AttemptStatus,
  type FailureReason,
  type PayoutAttempt,
} from "./payout-attempt.js";

const T0 = new Date("2026-11-06T10:00:00.000Z");
const T1 = new Date("2026-11-06T10:01:00.000Z");
const T2 = new Date("2026-11-06T10:02:00.000Z");
const T3 = new Date("2026-11-06T10:03:00.000Z");

function attempt(status: AttemptStatus, overrides: Partial<PayoutAttempt> = {}): PayoutAttempt {
  return {
    lineItemId: "item-1",
    attemptNo: 1,
    mode: "simulated",
    status,
    statusHistory: [{ status, at: T1 }],
    ...overrides,
  };
}

const ALLOWED: readonly (readonly [AttemptStatus, AttemptStatus])[] = [
  ["PLANNED", "QUOTED"],
  ["PLANNED", "FAILED"],
  ["QUOTED", "SIGNED"],
  ["QUOTED", "EXPIRED"],
  ["QUOTED", "FAILED"],
  ["SIGNED", "SUBMITTED"],
  ["SIGNED", "EXPIRED"],
  ["SIGNED", "FAILED"],
  ["SUBMITTED", "PROCESSING"],
  ["SUBMITTED", "SUCCESS"],
  ["SUBMITTED", "REFUNDED"],
  ["SUBMITTED", "FAILED"],
  ["PROCESSING", "SUCCESS"],
  ["PROCESSING", "REFUNDED"],
  ["PROCESSING", "FAILED"],
];

const reasonFor = (to: AttemptStatus): FailureReason | undefined =>
  to === "FAILED" ? "unknown" : undefined;

describe("statuses", () => {
  it("RECONCILED is no longer a status", () => {
    expect(ATTEMPT_STATUSES).not.toContain("RECONCILED");
    expect(ATTEMPT_STATUSES).toHaveLength(9);
  });
});

describe("transition table", () => {
  it("has exactly the allowed moves listed in this test", () => {
    const table = ATTEMPT_STATUSES.flatMap((from) =>
      ATTEMPT_TRANSITIONS[from].map((to) => `${from}->${to}`),
    );
    expect(table.sort()).toEqual(ALLOWED.map(([from, to]) => `${from}->${to}`).sort());
  });

  it.each(ALLOWED)("allows %s -> %s", (from, to) => {
    const next = transitionAttempt(attempt(from), to, T2, reasonFor(to));
    expect(next.status).toBe(to);
    expect(next.statusHistory.at(-1)).toEqual({ status: to, at: T2 });
  });

  const disallowed = ATTEMPT_STATUSES.flatMap((from) =>
    ATTEMPT_STATUSES.filter((to) => !ATTEMPT_TRANSITIONS[from].includes(to)).map(
      (to) => [from, to] as const,
    ),
  );

  it("covers all 81 pairs between allowed and disallowed", () => {
    expect(disallowed.length + ALLOWED.length).toBe(81);
  });

  it.each(disallowed)("rejects %s -> %s with a typed error", (from, to) => {
    let caught: unknown;
    try {
      transitionAttempt(attempt(from), to, T2, reasonFor(to));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    expect(caught).toMatchObject({ code: "TRANSITION_INVALID", from, to });
  });

  it("does not change the original attempt", () => {
    const original = attempt("PLANNED");
    transitionAttempt(original, "QUOTED", T2);
    expect(original.status).toBe("PLANNED");
    expect(original.statusHistory).toHaveLength(1);
  });

  it("records only observed states when a poll skips PROCESSING", () => {
    const end = transitionAttempt(attempt("SUBMITTED"), "SUCCESS", T2);
    expect(end.statusHistory.map((c) => c.status)).toEqual(["SUBMITTED", "SUCCESS"]);
  });
});

describe("failureReason", () => {
  it.each(FAILURE_REASONS)("FAILED accepts %s", (reason) => {
    expect(transitionAttempt(attempt("PLANNED"), "FAILED", T2, reason).failureReason).toBe(reason);
  });

  it("has exactly the six agreed reasons", () => {
    expect([...FAILURE_REASONS].sort()).toEqual(
      [
        "gate_blocked",
        "generate_intent_rejected",
        "quote_rejected",
        "settlement_failed",
        "submit_rejected",
        "unknown",
      ].sort(),
    );
  });

  it("FAILED without a reason throws", () => {
    expect(() => transitionAttempt(attempt("PLANNED"), "FAILED", T2)).toThrow(
      expect.objectContaining({ code: "ATTEMPT_FAILURE_REASON_REQUIRED" }),
    );
  });

  it("FAILED with an unknown reason throws", () => {
    expect(() =>
      transitionAttempt(attempt("PLANNED"), "FAILED", T2, "nope" as FailureReason),
    ).toThrow(expect.objectContaining({ code: "ATTEMPT_FAILURE_REASON_REQUIRED" }));
  });

  it("a reason on any other status throws", () => {
    expect(() => transitionAttempt(attempt("PLANNED"), "QUOTED", T2, "unknown")).toThrow(
      expect.objectContaining({ code: "ATTEMPT_FAILURE_REASON_NOT_ALLOWED" }),
    );
  });
});

describe("markReconciled (L36)", () => {
  it.each([
    ["SUCCESS", undefined],
    ["REFUNDED", undefined],
    ["FAILED", "settlement_failed"],
  ] as const)("sets reconciledAt on %s, keeping status", (status, failureReason) => {
    const done = markReconciled(attempt(status, failureReason ? { failureReason } : {}), T2);
    expect(done.reconciledAt).toBe(T2);
    expect(done.status).toBe(status);
    expect(done.statusHistory).toHaveLength(1);
  });

  it.each([
    ["EXPIRED", undefined],
    ["FAILED", "submit_rejected"],
    ["FAILED", "quote_rejected"],
    ["FAILED", "gate_blocked"],
    ["FAILED", "unknown"],
    ["PLANNED", undefined],
    ["QUOTED", undefined],
    ["SIGNED", undefined],
    ["SUBMITTED", undefined],
    ["PROCESSING", undefined],
  ] as const)("refuses %s %s", (status, failureReason) => {
    expect(() =>
      markReconciled(attempt(status, failureReason ? { failureReason } : {}), T2),
    ).toThrow(expect.objectContaining({ code: "ATTEMPT_NOT_RECONCILABLE" }));
  });

  it("refuses a second reconciliation", () => {
    expect(() => markReconciled(markReconciled(attempt("REFUNDED"), T1), T2)).toThrow(
      expect.objectContaining({ code: "ATTEMPT_ALREADY_RECONCILED" }),
    );
  });
});

describe("isTerminal", () => {
  it.each(ATTEMPT_STATUSES)("%s", (status) => {
    expect(isTerminal(status)).toBe(["SUCCESS", "REFUNDED", "FAILED", "EXPIRED"].includes(status));
  });

  it("splits every status into exactly one set", () => {
    expect([...TERMINAL_ATTEMPT_STATUSES, ...NON_TERMINAL_ATTEMPT_STATUSES].sort()).toEqual(
      [...ATTEMPT_STATUSES].sort(),
    );
  });
});

describe("canRetry", () => {
  it.each(ATTEMPT_STATUSES)("%s, not reconciled", (status) => {
    expect(canRetry(attempt(status))).toBe(status === "FAILED" || status === "EXPIRED");
  });

  it("REFUNDED only once reconciled", () => {
    expect(canRetry(attempt("REFUNDED"))).toBe(false);
    expect(canRetry(attempt("REFUNDED", { reconciledAt: T2 }))).toBe(true);
  });

  it("SUCCESS never, even once reconciled", () => {
    expect(canRetry(attempt("SUCCESS", { reconciledAt: T2 }))).toBe(false);
  });
});

describe("nextAttemptNumber", () => {
  it("starts at 1", () => {
    expect(nextAttemptNumber([])).toBe(1);
  });

  it("is one above the highest, even with gaps or out of order", () => {
    expect(nextAttemptNumber([{ attemptNo: 1 }])).toBe(2);
    expect(nextAttemptNumber([{ attemptNo: 3 }, { attemptNo: 1 }])).toBe(4);
  });
});

describe("assertAtMostOneNonTerminal", () => {
  it("accepts none or one", () => {
    expect(() => assertAtMostOneNonTerminal([])).not.toThrow();
    expect(() =>
      assertAtMostOneNonTerminal([attempt("FAILED"), attempt("PROCESSING", { attemptNo: 2 })]),
    ).not.toThrow();
  });

  it("rejects two", () => {
    expect(() =>
      assertAtMostOneNonTerminal([attempt("SIGNED"), attempt("PLANNED", { attemptNo: 2 })]),
    ).toThrow(AttemptInvariantError);
  });
});

describe("createFirstAttempt", () => {
  it("starts PLANNED at attempt 1, with the given mode", () => {
    const first = createFirstAttempt({
      lineItemId: "item-1",
      mode: "simulated",
      at: T0,
      existingAttempts: [],
    });
    expect(first).toMatchObject({ attemptNo: 1, status: "PLANNED", mode: "simulated" });
    expect(first.statusHistory).toEqual([{ status: "PLANNED", at: T0 }]);
  });

  it("refuses if attempts already exist", () => {
    expect(() =>
      createFirstAttempt({
        lineItemId: "item-1",
        mode: "live",
        at: T0,
        existingAttempts: [attempt("FAILED")],
      }),
    ).toThrow(AttemptInvariantError);
  });
});

describe("createRetryAttempt", () => {
  const retry = (attempts: readonly PayoutAttempt[], statusCheckedAt: Date = T2, at: Date = T3) =>
    createRetryAttempt({ lineItemId: "item-1", attempts, statusCheckedAt, at });

  it.each(["FAILED", "EXPIRED"] as const)("creates a new attempt after %s", (status) => {
    expect(retry([attempt(status)])).toMatchObject({ attemptNo: 2, status: "PLANNED" });
  });

  it("creates a new attempt after a reconciled REFUNDED", () => {
    expect(retry([attempt("REFUNDED", { reconciledAt: T1 })]).attemptNo).toBe(2);
  });

  it("refuses REFUNDED before reconciliation", () => {
    expect(() => retry([attempt("REFUNDED")])).toThrow(
      expect.objectContaining({ code: "ATTEMPT_NOT_RETRYABLE" }),
    );
  });

  it("leaves the previous attempt untouched and starts clean", () => {
    const previous = attempt("FAILED", { failureReason: "unknown" });
    const next = retry([previous]);
    expect(next).not.toBe(previous);
    expect(previous.status).toBe("FAILED");
    expect(next.failureReason).toBeUndefined();
  });

  it("numbers past every earlier attempt", () => {
    expect(retry([attempt("FAILED"), attempt("EXPIRED", { attemptNo: 2 })]).attemptNo).toBe(3);
  });

  it.each(["PLANNED", "QUOTED", "SIGNED", "SUBMITTED", "PROCESSING"] as const)(
    "refuses while the previous attempt is %s",
    (status) => {
      expect(() => retry([attempt(status)])).toThrow(
        expect.objectContaining({ code: "ATTEMPT_NON_TERMINAL_EXISTS" }),
      );
    },
  );

  it("refuses after SUCCESS, reconciled or not", () => {
    for (const paid of [attempt("SUCCESS"), attempt("SUCCESS", { reconciledAt: T1 })]) {
      expect(() => retry([paid])).toThrow(
        expect.objectContaining({ code: "ATTEMPT_ALREADY_PAID" }),
      );
    }
  });

  it("refuses if any earlier attempt succeeded, even with a later failure", () => {
    expect(() => retry([attempt("SUCCESS"), attempt("FAILED", { attemptNo: 2 })])).toThrow(
      expect.objectContaining({ code: "ATTEMPT_ALREADY_PAID" }),
    );
  });

  it("refuses with no previous attempt", () => {
    expect(() => retry([])).toThrow(expect.objectContaining({ code: "ATTEMPT_NONE_TO_RETRY" }));
  });

  it("refuses attempts from another line item", () => {
    expect(() => retry([attempt("FAILED", { lineItemId: "item-2" })])).toThrow(
      expect.objectContaining({ code: "ATTEMPT_WRONG_LINE_ITEM" }),
    );
  });

  it("refuses if live and simulated attempts are mixed", () => {
    expect(() =>
      retry([attempt("FAILED"), attempt("FAILED", { attemptNo: 2, mode: "live" })]),
    ).toThrow(ModeMismatchError);
  });

  describe("rule 3: a status check is required", () => {
    it("refuses a missing statusCheckedAt", () => {
      expect(() =>
        createRetryAttempt({
          lineItemId: "item-1",
          attempts: [attempt("FAILED")],
          statusCheckedAt: undefined as unknown as Date,
          at: T3,
        }),
      ).toThrow(expect.objectContaining({ code: "ATTEMPT_STATUS_CHECK_REQUIRED" }));
    });

    it("is also required after a reconciled refund", () => {
      expect(() =>
        createRetryAttempt({
          lineItemId: "item-1",
          attempts: [attempt("REFUNDED", { reconciledAt: T1 })],
          statusCheckedAt: undefined as unknown as Date,
          at: T3,
        }),
      ).toThrow(expect.objectContaining({ code: "ATTEMPT_STATUS_CHECK_REQUIRED" }));
    });

    it("refuses an invalid date", () => {
      expect(() => retry([attempt("FAILED")], new Date("nonsense"))).toThrow(
        expect.objectContaining({ code: "ATTEMPT_STATUS_CHECK_REQUIRED" }),
      );
    });

    it("refuses a check older than the attempt's last status change", () => {
      expect(() => retry([attempt("FAILED")], T0)).toThrow(
        expect.objectContaining({ code: "ATTEMPT_STATUS_CHECK_STALE" }),
      );
    });

    it("refuses a check dated after the retry", () => {
      expect(() => retry([attempt("FAILED")], T3, T2)).toThrow(
        expect.objectContaining({ code: "ATTEMPT_STATUS_CHECK_FUTURE" }),
      );
    });

    it("accepts a check at the exact moment of the last change", () => {
      expect(() => retry([attempt("FAILED")], T1)).not.toThrow();
    });
  });
});

describe("attemptOutcome", () => {
  it.each([
    ["SUCCESS", "success"],
    ["REFUNDED", "refunded"],
    ["FAILED", "failed"],
    ["EXPIRED", "expired"],
    ["PLANNED", "in_flight"],
    ["QUOTED", "in_flight"],
    ["SIGNED", "in_flight"],
    ["SUBMITTED", "in_flight"],
    ["PROCESSING", "in_flight"],
  ] as const)("%s is %s", (status, outcome) => {
    expect(attemptOutcome(attempt(status))).toBe(outcome);
  });
});
