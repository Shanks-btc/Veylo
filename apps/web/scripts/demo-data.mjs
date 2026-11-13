// Test data for the browser checks (scripts/e2e.mjs) and the demo dev server (pnpm dev:web).
// Every name and amount here is made up and labelled "(test)"; none of it is real.
export const ORG = "11111111-1111-4111-8111-111111111111";
export const RUN = "22222222-2222-4222-8222-222222222222";
export const ADA = "33333333-3333-4333-8333-333333333333";
export const KWAME = "44444444-4444-4444-8444-444444444444";
const AT = "2026-11-26T10:00:00.000Z";
const contractor = (id, name, payoutMode) => ({
  id,
  orgId: ORG,
  name,
  email: null,
  terms: {},
  payoutMode,
  status: "active",
  createdAt: AT,
});
const attempt = (status) => ({
  attemptNo: 1,
  status,
  failureReason: status === "FAILED" ? "Route unavailable" : null,
  depositAddress: null,
  requestedDeadline: AT,
  quoteDeadline: AT,
  amountIn: "4201.10",
  minAmountIn: "4201.10",
  mode: "live",
});
const item = (id, contractorId, amount, status, extra = {}) => ({
  id,
  contractorId,
  destinationId: "55555555-5555-4555-8555-55555555555" + id.slice(-1),
  amount,
  memo: null,
  flags: [],
  blocked: false,
  feePreview: {
    fee: "1.10",
    asOf: AT,
    amountIn: amount,
    amountOut: amount,
    deliveryFee: "0.10",
    minAmountIn: amount,
  },
  mode: "live",
  attempt: status ? attempt(status) : null,
  ...extra,
});
const payRun = (statuses) => ({
  id: RUN,
  period: "2026-11",
  status: "Signing",
  mode: "live",
  simulated: false,
  label: null,
  approvedBy: null,
  readyToSign: "ready_to_sign",
  totals: { payoutSum: "7350.00", feeSum: "2.20", grandTotal: "7352.20" },
  items: [
    item("66666666-6666-4666-8666-666666666661", ADA, "4200.00", statuses[0]),
    item("66666666-6666-4666-8666-666666666662", KWAME, "3150.00", statuses[1]),
    item("66666666-6666-4666-8666-666666666663", KWAME, "50.00", null, {
      blocked: true,
      flags: [
        {
          code: "duplicate_payee",
          detail: "Second payout to this person in the run",
          blocking: true,
        },
      ],
    }),
  ],
  funds: { checked: false, reason: "not checked in test" },
});
const balance = (amount) => ({
  available: true,
  tokenId: "nep141:usdc",
  amount,
  source: "near-rpc",
  asOf: AT,
});

/** The API's answer for a path, or undefined (404). `statusMode` picks the pay run's payout states. */
export function demoAnswer(method, path, statusMode = "review") {
  if (path === "/me")
    return {
      user: { id: ORG, nearAccountId: "northwind-test.near" },
      memberships: [{ orgId: ORG, orgName: "Test organisation", role: "owner" }],
    };
  if (path === `/orgs/${ORG}/treasury/balances`)
    return {
      treasuryAccountId: "northwind-test.near",
      public: balance("1250000000"),
      confidential: balance("20000000000"),
    };
  if (path === `/orgs/${ORG}/pay-runs`)
    return {
      payRuns: [
        {
          id: RUN,
          period: "2026-11",
          status: "Signing",
          mode: "live",
          simulated: false,
          totalAmount: "7352.20",
        },
      ],
    };
  if (path === `/orgs/${ORG}/pay-runs/${RUN}`)
    return payRun(statusMode === "review" ? ["QUOTED", "QUOTED"] : ["SUCCESS", "PROCESSING"]);
  if (path === `/orgs/${ORG}/contractors`)
    return {
      contractors: [
        contractor(ADA, "Ada (test)", "private"),
        contractor(KWAME, "Kwame (test)", "direct"),
      ],
    };
  if (path === `/orgs/${ORG}/contractors/${ADA}`) return contractor(ADA, "Ada (test)", "private");
  if (path.startsWith(`/orgs/${ORG}/contractors/`) && path.endsWith("/destinations"))
    return { destinations: [] };
  if (path === `/orgs/${ORG}/payee-registry`) return { head: null, approvals: [] };
  if (path === `/orgs/${ORG}/ledger`) return { items: [], nextCursor: null };
  return undefined;
}
