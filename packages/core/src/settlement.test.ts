import { describe, expect, it } from "vitest";
import { ATTEMPT_STATUSES } from "./payout-attempt.js";
import { mapOneClickStatus } from "./settlement.js";

describe("mapOneClickStatus", () => {
  it.each([
    ["SUBMITTED", "PENDING_DEPOSIT", {}],
    ["SUBMITTED", "KNOWN_DEPOSIT_TX", {}],
    ["SUBMITTED", "PROCESSING", { to: "PROCESSING" }],
    ["SUBMITTED", "SUCCESS", { to: "SUCCESS" }],
    ["SUBMITTED", "REFUNDED", { to: "REFUNDED" }],
    ["SUBMITTED", "FAILED", { to: "FAILED", failureReason: "settlement_failed" }],
    ["PROCESSING", "PROCESSING", {}],
    ["PROCESSING", "PENDING_DEPOSIT", {}],
    ["PROCESSING", "SUCCESS", { to: "SUCCESS" }],
    ["PROCESSING", "REFUNDED", { to: "REFUNDED" }],
    ["PROCESSING", "FAILED", { to: "FAILED", failureReason: "settlement_failed" }],
  ] as const)("%s seeing %s", (current, observed, expected) => {
    expect(mapOneClickStatus(current, observed)).toEqual(expected);
  });

  it("SUCCESS straight from SUBMITTED records no invented PROCESSING (L18)", () => {
    expect(mapOneClickStatus("SUBMITTED", "SUCCESS").to).toBe("SUCCESS");
  });

  it.each(["INCOMPLETE_DEPOSIT", "WHATEVER", ""])("an unexpected %j fails with an alert", (s) => {
    const r = mapOneClickStatus("SUBMITTED", s);
    expect(r).toMatchObject({ to: "FAILED", failureReason: "settlement_failed" });
    expect(r.alert).toContain("unexpected");
  });

  it.each(ATTEMPT_STATUSES.filter((s) => s !== "SUBMITTED" && s !== "PROCESSING"))(
    "%s is never moved by a poll",
    (current) => {
      expect(mapOneClickStatus(current, "SUCCESS")).toEqual({});
    },
  );
});
