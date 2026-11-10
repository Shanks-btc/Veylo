import type { PayoutMode } from "./routes.js";

export type HygieneDestination = {
  readonly address: string;
  readonly payoutMode: PayoutMode;
  readonly status: "candidate" | "active" | "superseded";
  /** Set by payouts when this address received a public payout from the company. */
  readonly receivedPublicPayout: boolean;
};

export type HygieneWarning = {
  readonly code: "SWITCH_TO_PRIVATE_WITH_PUBLIC_ADDRESS" | "CASH_OUT_TO_PUBLIC_ADDRESS";
  readonly address: string;
  readonly message: string;
};

/**
 * Rule 8. The privacy claim holds only if the payout address never received a public payment from
 * the company, so reusing one of those addresses links the contractor back to it.
 */
export function addressHygieneWarnings(input: {
  readonly destinations: readonly HygieneDestination[];
  /** Where a contractor is about to withdraw a confidential balance to, if anywhere. */
  readonly cashOutAddress?: string;
}): HygieneWarning[] {
  const flagged = [
    ...new Set(input.destinations.filter((d) => d.receivedPublicPayout).map((d) => d.address)),
  ];
  const warnings: HygieneWarning[] = [];

  const goingPrivate = input.destinations.some(
    (d) => d.payoutMode === "private" && d.status !== "superseded",
  );
  const directFlagged = input.destinations.filter(
    (d) => d.payoutMode === "direct" && d.receivedPublicPayout,
  );
  if (goingPrivate) {
    for (const address of new Set(directFlagged.map((d) => d.address))) {
      warnings.push({
        code: "SWITCH_TO_PRIVATE_WITH_PUBLIC_ADDRESS",
        address,
        message:
          "This address received a public payout from the company. Cash out from private receipt to a fresh address instead.",
      });
    }
  }
  if (input.cashOutAddress !== undefined && flagged.includes(input.cashOutAddress)) {
    warnings.push({
      code: "CASH_OUT_TO_PUBLIC_ADDRESS",
      address: input.cashOutAddress,
      message:
        "Cashing out to this address links the payout to the company, because it received a public payout from them. Use a fresh address.",
    });
  }
  return warnings;
}
