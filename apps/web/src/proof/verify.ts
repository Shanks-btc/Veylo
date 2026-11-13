// The verify-payout page's checks (slice W5, C2). A direct payout is re-checked from NEAR on every
// load: its transactions exist and succeeded, the amount is the payslip's amount, the recipient is
// the approved payee. A private payout claims nothing beyond what is recorded.
import { mentions, visibleText } from "./mentions";
import { finalSuccess, ProofUnavailable, type ProofRpc } from "./rpc";

export type Check = { readonly label: string; readonly ok: boolean; readonly detail: string };

export type DirectVerification =
  | { readonly status: "verified" | "failed"; readonly checkedAt: Date; readonly checks: Check[] }
  | { readonly status: "unavailable"; readonly checkedAt: Date; readonly reason: string };

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function verifyDirectPayout(input: {
  /** The NEAR transactions recorded on the payslip. */
  nearTxHashes: readonly string[];
  /** The payslip's recipient and amount (USDC units). */
  payslipRecipient: string;
  payslipAmountUnits: string;
  /** The payslip's delivery fee in USDC units: a withdrawal on NEAR moves amount plus this fee. */
  deliveryFeeUnits?: string;
  /** The recipient on the owner-signed, verified payee record; undefined if there is none. */
  approvedRecipient: string | undefined;
  rpc: ProofRpc;
  now: () => Date;
}): Promise<DirectVerification> {
  if (input.nearTxHashes.length === 0)
    return {
      status: "unavailable",
      checkedAt: input.now(),
      reason: "no NEAR transaction is recorded for this payout yet",
    };
  try {
    const txs: unknown[] = [];
    for (const hash of input.nearTxHashes) txs.push(await input.rpc.tx(hash));
    const ids = { treasury: "", deposit: "", recipient: input.payslipRecipient };
    const fee = input.deliveryFeeUnits ?? "0";
    const amounts = [
      input.payslipAmountUnits,
      (BigInt(input.payslipAmountUnits) + BigInt(fee)).toString(),
    ];
    const checks: Check[] = [
      {
        label: "The transactions exist on NEAR and succeeded",
        ok: txs.every(finalSuccess),
        detail: `${txs.length} checked`,
      },
      {
        label: "The recipient is the approved payee",
        ok:
          input.approvedRecipient !== undefined &&
          sameAddress(input.approvedRecipient, input.payslipRecipient),
        detail: input.approvedRecipient ? "matches the signed payee list" : "no signed payee found",
      },
      {
        label: "A transaction names that recipient",
        ok: txs.some((t) => mentions(t, ids).recipient),
        detail: "read from the transaction's public data",
      },
      {
        label: "The amount equals the payslip",
        // Exactly the payslip amount, or that amount plus the recorded delivery fee (the NEAR
        // side of a withdrawal moves both). No tolerance.
        ok: txs.some((t) => amounts.some((a) => visibleText(t).includes(`"${a}"`))),
        detail: `${input.payslipAmountUnits} units (delivery fee ${fee})`,
      },
    ];
    return {
      status: checks.every((c) => c.ok) ? "verified" : "failed",
      checkedAt: input.now(),
      checks,
    };
  } catch (err) {
    return {
      status: "unavailable",
      checkedAt: input.now(),
      reason: err instanceof ProofUnavailable ? err.message : "couldn't check right now",
    };
  }
}

/** A private payout: what is recorded, and nothing more is claimed. */
export function privatePayoutFacts(input: {
  status: string;
  intentHash: string | null;
  intentsExplorerUrl: string | null;
}) {
  return {
    status: input.status,
    intentHash: input.intentHash,
    intentsExplorerUrl: input.intentsExplorerUrl,
    note: "This payout was paid from the confidential balance, so there is no public transaction to re-check. The status and intent hash are what NEAR Intents recorded.",
  };
}
