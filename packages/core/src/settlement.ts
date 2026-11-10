import type { AttemptStatus, FailureReason } from "./payout-attempt.js";

/**
 * What a 1Click status means for a submitted attempt. Only observed states are recorded (L18): a
 * poll that sees SUCCESS straight after SUBMITTED records SUCCESS, never an invented PROCESSING.
 * `to` undefined means no change.
 */
export function mapOneClickStatus(
  current: AttemptStatus,
  observed: string,
): { to?: AttemptStatus; failureReason?: FailureReason; alert?: string } {
  if (current !== "SUBMITTED" && current !== "PROCESSING") return {};
  switch (observed) {
    case "PENDING_DEPOSIT":
    case "KNOWN_DEPOSIT_TX":
      // Never backwards: a PROCESSING attempt seeing an earlier state stays PROCESSING.
      return {};
    case "PROCESSING":
      return current === "PROCESSING" ? {} : { to: "PROCESSING" };
    case "SUCCESS":
      return { to: "SUCCESS" };
    case "REFUNDED":
      return { to: "REFUNDED" };
    case "FAILED":
      return { to: "FAILED", failureReason: "settlement_failed" };
    default:
      return {
        to: "FAILED",
        failureReason: "settlement_failed",
        alert: `unexpected 1Click status: ${observed.slice(0, 40)}`,
      };
  }
}

/** Statuses that show 1Click has our submitted intent. Used when a submit's outcome is unknown. */
export const ONECLICK_HAS_INTENT = new Set([
  "KNOWN_DEPOSIT_TX",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
  "INCOMPLETE_DEPOSIT",
]);
