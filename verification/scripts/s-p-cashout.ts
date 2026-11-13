// Spike S-P (slice W5, D3): the contractor portal's cash-out, live. It is the T5d flow
// (scripts/t5d.ts: EXACT_OUTPUT 0.03 USDC from the recipient's confidential balance to Base, capped at
// 0.05 USDC, then a privacy check) that already ran on mainnet (docs/EVIDENCE.md rows 24 to 26).
//
// MAINNET. NOT RUN in slice W5. It refuses to start unless S_P_FOUNDER_APPROVED=yes is set for the
// one run the founder approved. It adds no code of its own on the money path: after the approval
// check it runs t5d.ts unchanged, with t5d's own caps and stops.
// Run (only after approval): S_P_FOUNDER_APPROVED=yes npx tsx scripts/s-p-cashout.ts
if (process.env.S_P_FOUNDER_APPROVED !== "yes") {
  console.log(
    "STOPPED: S-P is a mainnet cash-out. Set S_P_FOUNDER_APPROVED=yes only for the run the founder approved.",
  );
  process.exit(1);
}
await import("./t5d.js");
