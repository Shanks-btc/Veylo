// A contractor's cash-out (slice W5, D3): moving their own confidential USDC to an address they
// typed. It mirrors the treasury payout's browser checks, for the contractor's money:
//   A       the quote carries NEAR Intents' real signature (the pinned key);
//   recipient  the quote pays exactly the address the contractor typed;
//   C       the quote's amount and refund are exactly right, the fee is within its ceiling, and the
//           payload the wallet would sign is one transfer of the quoted amount, from them.
// Any failure refuses; nothing is signed on a "mostly". Live cash-out is spike S-P (not run).
import type { signRequestResponse } from "@veylo/contract";
import type { z } from "zod";
import { gateC } from "../gates";
import { gateA, readSignedQuote } from "../gates/signed-quote";

export type CashOutCheck = { label: string; passed: boolean; reason: string };

export function checkCashOut(input: {
  quote: unknown;
  payload: z.infer<typeof signRequestResponse>["payload"];
  /** The contractor's own account: it signs and receives any refund. */
  contractorAccountId: string;
  /** What the contractor typed. */
  recipient: string;
  /** What they asked to receive, as the decimal the screen shows. */
  amount: string;
  saltHex: string;
}): { passed: boolean; checks: CashOutCheck[] } {
  const a = gateA(input.quote);
  const signed = readSignedQuote(input.quote);
  const recipientOk = signed !== undefined && signed.recipient === input.recipient;
  const c = gateC({
    item: { amount: input.amount } as never,
    quote: input.quote,
    payload: input.payload,
    treasuryAccountId: input.contractorAccountId,
    saltHex: input.saltHex,
  });
  const checks: CashOutCheck[] = [
    { label: "The quote is signed by NEAR Intents", passed: a.passed, reason: a.reason },
    {
      label: "It pays the address you typed",
      passed: recipientOk,
      reason: recipientOk ? "ok" : "the quote pays another address",
    },
    { label: "The amount, fee, refund and payload are right", passed: c.passed, reason: c.reason },
  ];
  return { passed: checks.every((x) => x.passed), checks };
}
