// The API's response contract (slice W1): one Zod schema per route, for every 2xx response. The web
// client validates every response against it and treats a mismatch as an error, never using part
// of a response. The API test harness validates every 2xx response it sends against the same
// schemas, so the contract can't drift from the server.
//
// Not in packages/core, which has no dependencies (AGENTS.md); Zod is pinned here as everywhere.
import { z } from "zod";

const uuid = z.uuid();
/** An ISO 8601 timestamp, as the API serializes a Date. */
const isoDate = z.iso.datetime({ offset: true });
/** A fixed-decimal amount string, such as "0.050000". Never a float. */
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
/** Smallest units as a string. */
const units = z.string().regex(/^\d+$/);
const ok = z.object({ ok: z.literal(true) });

export const statusHistory = z.array(z.object({ status: z.string(), at: isoDate }));

// --- Auth ---
export const challengeResponse = z.object({
  message: z.string().min(1),
  nonce: z.string().min(1),
  recipient: z.string().min(1),
});
export const verifyResponse = z.object({ accountId: z.string().min(1) });
/** An email account's state after sign-up or sign-in (W6). */
export const accountState = z.object({ email: z.string().nullable(), emailVerified: z.boolean() });
export const meResponse = z.object({
  user: z.object({
    id: uuid,
    // Null for an account made with an email only, until a wallet is linked.
    nearAccountId: z.string().nullable(),
    email: z.string().nullable(),
    emailVerified: z.boolean(),
  }),
  memberships: z.array(
    z.object({
      orgId: uuid,
      orgName: z.string(),
      role: z.enum(["owner", "viewer", "accountant", "preparer"]),
    }),
  ),
});

// --- Orgs and members ---
export const organization = z.object({ id: uuid, name: z.string(), treasuryAccountId: z.string() });
const role = z.enum(["owner", "viewer", "accountant", "preparer"]);
export const membersResponse = z.object({
  members: z.array(
    z.object({
      userId: uuid,
      nearAccountId: z.string().nullable(),
      email: z.string().nullable(),
      role,
    }),
  ),
});
export const memberAdded = z.object({ userId: uuid, nearAccountId: z.string().nullable(), role });
export const memberRole = z.object({ userId: uuid, role });

// --- Contractors and destinations ---
export const contractor = z.object({
  id: uuid,
  orgId: uuid,
  name: z.string(),
  email: z.string().nullable(),
  /** Display only: the contractor's own estimate currency (null: the organisation's). */
  displayCurrency: z.string().nullable(),
  terms: z.record(z.string(), z.unknown()),
  payoutMode: z.enum(["direct", "private"]).nullable(),
  status: z.string(),
  createdAt: isoDate,
});
export const contractorsResponse = z.object({ contractors: z.array(contractor) });
export const destination = z.object({
  id: uuid,
  contractorId: uuid,
  route: z.string(),
  payoutMode: z.enum(["direct", "private"]),
  chain: z.string(),
  assetId: z.string(),
  address: z.string(),
  status: z.enum(["candidate", "active", "superseded"]),
  supersededAt: isoDate.nullable(),
  check: z.object({
    status: z.string(),
    reason: z.string().nullable(),
    checkedAt: isoDate.nullable(),
  }),
  feePreview: z
    .object({
      amountIn: decimal,
      amountOut: decimal,
      impliedFee: decimal,
      deliveryFee: decimal,
      minAmountIn: decimal,
      impliedFeeBps: z.string(),
    })
    .nullable(),
  receivedPublicPayout: z.boolean(),
  enteredBy: z.string(),
  contractorConfirmedAt: isoDate.nullable(),
  payable: z.boolean(),
  payableReason: z.string(),
  warnings: z.array(z.object({ code: z.string(), address: z.string(), message: z.string() })),
});
export const destinationsResponse = z.object({ destinations: z.array(destination) });
export const approvalRequest = z.object({
  requestId: uuid,
  approvalMessage: z.string(),
  approvalNonce: z.string(),
  headMessage: z.string(),
  headNonce: z.string(),
  recipient: z.string(),
  expiresAt: isoDate,
});
export const revokeRequest = z.object({
  requestId: uuid,
  headMessage: z.string(),
  headNonce: z.string(),
  recipient: z.string(),
  expiresAt: isoDate,
});
export const headChange = z.object({ approvalId: uuid, headVersion: z.number().int().positive() });

// --- Payee registry (gate B input; every field is re-verified in the browser) ---
export const registryHead = z.object({
  version: z.number().int().positive(),
  activeSetHash: z.string(),
  ownerPublicKey: z.string(),
  signature: z.string(),
  signedAt: isoDate,
  nonce: z.string(),
  message: z.string(),
  recipient: z.string(),
  recordHashes: z.array(z.string()),
  signerAccountId: z.string(),
});
export const registryApproval = z.object({
  id: uuid,
  destinationId: uuid,
  version: z.number().int().positive(),
  contractorName: z.string(),
  ownerAccountId: z.string(),
  ownerPublicKey: z.string(),
  signature: z.string(),
  approvedAt: isoDate,
  expiresAt: isoDate,
  nonce: z.string(),
  message: z.string(),
  recipient: z.string(),
  recordHash: z.string(),
  canonicalRecord: z.string(),
});
export const payeeRegistryResponse = z.object({
  head: registryHead.nullable(),
  approvals: z.array(registryApproval),
});
/** Every signed version of the payee list, newest first, each with the approvals it names. */
export const payeeHistoryResponse = z.object({ versions: z.array(payeeRegistryResponse) });

// --- Settings and display currency (W6) ---
export const orgSettings = z.object({
  name: z.string(),
  treasuryAccountId: z.string(),
  displayCurrency: z.string(),
  timeZone: z.string(),
  notifications: z.object({
    payrollReady: z.boolean(),
    payoutSettled: z.boolean(),
    weeklySummary: z.boolean(),
  }),
});
/** Display-only rates: never an input to money. Unavailable means the screens say so. */
export const fxResponse = z.union([
  z.object({
    available: z.literal(true),
    base: z.literal("USD"),
    rates: z.record(z.string(), decimal),
    source: z.object({
      name: z.string(),
      url: z.string(),
      termsUrl: z.string(),
      attribution: z.string(),
    }),
    fetchedAt: isoDate,
    providerUpdatedAt: isoDate.nullable(),
  }),
  z.object({ available: z.literal(false) }),
]);
export const displayCurrencyChoice = z.object({ displayCurrency: z.string().nullable() });

// --- Pay runs ---
const flag = z.object({ code: z.string(), detail: z.string().optional(), blocking: z.boolean() });
const itemAttempt = z.object({
  attemptNo: z.number().int().positive(),
  status: z.string(),
  failureReason: z.string().nullable(),
  depositAddress: z.string().nullable(),
  requestedDeadline: isoDate.nullable(),
  quoteDeadline: isoDate.nullable(),
  amountIn: decimal.nullable(),
  minAmountIn: decimal.nullable(),
  mode: z.enum(["live", "simulated"]),
});
export const payRunItem = z.object({
  id: uuid,
  contractorId: uuid,
  destinationId: uuid.nullable(),
  amount: decimal,
  memo: z.string().nullable(),
  flags: z.array(flag),
  blocked: z.boolean(),
  feePreview: z
    .object({
      fee: decimal,
      asOf: isoDate,
      amountIn: decimal,
      amountOut: decimal,
      deliveryFee: decimal,
      minAmountIn: decimal,
      /** What the contractor receives (W6). Absent means USDC. */
      asset: z.enum(["USDC", "NEAR"]).optional(),
      /** USDC per NEAR from the quote's own amounts. */
      rate: z.string().nullable().optional(),
    })
    .nullable(),
  mode: z.enum(["live", "simulated"]),
  attempt: itemAttempt.nullable(),
});
export const payRun = z.object({
  id: uuid,
  period: z.string(),
  status: z.string(),
  mode: z.enum(["live", "simulated"]),
  simulated: z.boolean(),
  label: z.string().nullable(),
  approvedBy: uuid.nullable(),
  readyToSign: z.enum(["ready_to_sign", "ready_to_sign_simulated"]).nullable(),
  totals: z.object({ payoutSum: decimal, feeSum: decimal, grandTotal: decimal }),
  items: z.array(payRunItem),
});
export const payRunApproved = payRun.extend({
  funds: z.union([
    z.object({ checked: z.literal(true), available: decimal, needed: decimal }),
    z.object({ checked: z.literal(false), reason: z.string() }),
  ]),
});
export const payRunsResponse = z.object({
  payRuns: z.array(
    z.object({
      id: uuid,
      period: z.string(),
      status: z.string(),
      mode: z.enum(["live", "simulated"]),
      simulated: z.boolean(),
      totalAmount: decimal,
      scheduledFor: z.string().nullable(),
      readyForReview: z.boolean(),
    }),
  ),
});
export const itemCreated = z.object({ id: uuid });
const addressChange = z.object({
  id: uuid,
  route: z.string(),
  address: z.string(),
  requestedAt: isoDate,
  appliesAfter: isoDate,
  applied: z.boolean(),
  canApply: z.boolean(),
});
export const addressChangesResponse = z.object({ changes: z.array(addressChange) });
export const inviteResponse = z.object({ token: z.string(), expiresAt: isoDate });
export const acceptResponse = z.object({ orgId: uuid, contractorId: uuid });
export const portalMe = z.object({
  contractors: z.array(
    z.object({
      orgId: uuid,
      orgName: z.string(),
      contractorId: uuid,
      name: z.string(),
      displayCurrency: z.string().nullable(),
      orgDisplayCurrency: z.string(),
    }),
  ),
});
export const portalPayslips = z.object({
  payslips: z.array(
    z.object({
      itemId: uuid,
      payRunId: uuid,
      period: z.string(),
      amount: decimal.nullable(),
      currency: z.literal("USDC"),
      /** What they received: USDC, or NEAR sized at quote time (W6). */
      paidCurrency: z.enum(["USDC", "NEAR"]),
      paidAmount: decimal.nullable(),
      rate: z.string().nullable(),
      quoteAsOf: z.string().nullable(),
      route: z.string().nullable(),
      status: z.string(),
      at: isoDate,
    }),
  ),
});
export const portalDestinations = z.object({
  destinations: z.array(
    z.object({
      id: uuid,
      route: z.string(),
      address: z.string(),
      status: z.string(),
      checkStatus: z.string(),
    }),
  ),
});
export const portalBalance = z.union([
  z.object({
    available: z.literal(true),
    tokenId: z.string(),
    amount: units,
    source: z.string(),
    asOf: isoDate,
  }),
  z.object({
    available: z.literal(false),
    unavailable: z.string(),
    source: z.string(),
    asOf: isoDate,
  }),
]);
export const scheduleResponse = z.object({
  schedule: z
    .object({
      kind: z.enum(["monthly", "biweekly"]),
      dayOfMonth: z.number().int().nullable(),
      anchorDate: z.string().nullable(),
      timeZone: z.string(),
      paused: z.boolean(),
    })
    .nullable(),
  next: z.object({ payday: z.string(), prepareOn: z.string() }).nullable(),
});
export const importResponse = z.object({
  rows: z.array(
    z.object({
      line: z.number().int(),
      name: z.string(),
      ok: z.boolean(),
      problems: z.array(z.string()),
    }),
  ),
  saved: z.boolean(),
  created: z.number().int().nonnegative(),
});

// --- Signing (gate A, B and C input; the gate re-verifies all of it) ---
export const intentPayload = z.object({
  message: z.string(),
  nonce: z.string(),
  recipient: z.string(),
});
/** A 1Click quote response as stored. Unsigned fields are kept, but gates never read them. */
export const storedQuote = z
  .object({
    quote: z.record(z.string(), z.unknown()),
    quoteRequest: z.record(z.string(), z.unknown()),
    signature: z.string(),
    timestamp: isoDate,
  })
  .loose();
export const signRequestResponse = z.object({
  requestId: uuid,
  payload: intentPayload,
  expiresAt: isoDate,
  summary: z.string(),
  gate: z.object({
    treasuryAccountId: z.string(),
    quote: storedQuote,
    payeeApproval: z
      .object({
        nonce: z.string(),
        message: z.string(),
        recipient: z.string(),
        recordHash: z.string(),
        canonicalRecord: z.string(),
        ownerAccountId: z.string(),
        ownerPublicKey: z.string(),
        signature: z.string(),
        contractorName: z.string(),
        version: z.number().int().positive(),
      })
      .nullable(),
    registryHead: registryHead.nullable(),
  }),
});
export const signComplete = z.object({
  attemptId: uuid,
  status: z.string(),
  submitOutcome: z.string(),
  intentHash: z.string().nullable(),
});
export const retryResponse = z.object({
  attemptNo: z.number().int().positive(),
  status: z.string(),
});

// --- Reporting ---
const ledgerPayout = z.object({
  kind: z.literal("payout"),
  id: uuid,
  at: isoDate,
  mode: z.enum(["live", "simulated"]),
  simulated: z.boolean(),
  label: z.string().nullable(),
  payRunId: uuid,
  period: z.string(),
  itemId: uuid,
  contractor: z.object({ id: uuid, name: z.string() }),
  attemptNo: z.number().int().positive(),
  status: z.string(),
  failureReason: z.string().nullable(),
  statusHistory,
  /** The approved USD value, in USDC (the salary is set in USD). */
  amount: decimal.nullable(),
  currency: z.literal("USDC"),
  /** What the contractor received (W6): USDC, or NEAR sized at quote time. */
  paidCurrency: z.enum(["USDC", "NEAR"]),
  paidAmount: decimal.nullable(),
  /** USDC per NEAR from the quote's own amounts, fee included; null for a USDC payout. */
  rate: z.string().nullable(),
  route: z.string().nullable(),
  routeLabel: z.string().nullable(),
  chain: z.string().nullable(),
  recipient: z.string().nullable(),
  amountIn: decimal.nullable(),
  minAmountIn: decimal.nullable(),
  deliveryFee: decimal.nullable(),
  totalFee: decimal.nullable(),
  quoteAsOf: isoDate.nullable(),
  refundedAmount: decimal.nullable(),
  reconciled: z.boolean(),
  reconciledAt: isoDate.nullable(),
  balanceUnconfirmed: z.boolean().nullable(),
  hashes: z.object({
    depositAddress: z.string().nullable(),
    correlationId: z.string().nullable(),
    intentHash: z.string().nullable(),
    settlementIntentHashes: z.array(z.string()),
    nearTxHashes: z.array(z.string()),
    destinationTxHash: z.string().nullable(),
  }),
  links: z.object({
    intentsExplorer: z.url().nullable(),
    nearTxs: z.array(z.url()),
    destinationTx: z.url().nullable(),
  }),
});
const ledgerTreasuryEvent = z.object({
  kind: z.literal("treasury_event"),
  id: uuid,
  at: isoDate,
  type: z.enum(["fund", "shield"]),
  mode: z.enum(["live", "simulated"]),
  simulated: z.boolean(),
  label: z.string().nullable(),
  status: z.string(),
  statusHistory,
  originAsset: z.string(),
  originAmount: units,
  destinationAmount: decimal.nullable(),
  hashes: z.object({
    depositAddress: z.string(),
    correlationId: z.string(),
    intentHash: z.string().nullable(),
    nearTxHashes: z.array(z.string()),
  }),
  links: z.object({ intentsExplorer: z.url().nullable(), nearTxs: z.array(z.url()) }),
});
export const ledgerResponse = z.object({
  items: z.array(z.discriminatedUnion("kind", [ledgerPayout, ledgerTreasuryEvent])),
  nextCursor: z.string().nullable(),
});
export const payslipResponse = z.object({
  contractor: z.object({ id: uuid, name: z.string() }),
  period: z.string(),
  amount: decimal.nullable(),
  currency: z.literal("USDC"),
  paidCurrency: z.enum(["USDC", "NEAR"]),
  paidAmount: decimal.nullable(),
  rate: z.string().nullable(),
  route: z.string().nullable(),
  chain: z.string().nullable(),
  recipient: z.string().nullable(),
  deliveryFee: decimal.nullable(),
  totalFee: decimal.nullable(),
  quoteAsOf: isoDate.nullable(),
  status: z.string(),
  reconciled: z.boolean(),
  reconciledAt: isoDate.nullable(),
  refundedAmount: decimal.nullable(),
  hashes: ledgerPayout.shape.hashes,
  links: ledgerPayout.shape.links,
  timestamps: statusHistory,
  attempts: z.number().int().positive(),
  mode: z.enum(["live", "simulated"]),
  simulated: z.boolean(),
  label: z.string().nullable(),
});
export const auditResponse = z.object({
  items: z.array(
    z.object({
      id: uuid,
      at: isoDate,
      actor: z.string(),
      action: z.string(),
      entity: z.string(),
      entityId: z.string(),
      txHash: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

// --- Treasury ---
const balance = z.union([
  z.object({
    available: z.literal(true),
    tokenId: z.string(),
    amount: units,
    source: z.string(),
    asOf: isoDate,
  }),
  z.object({
    available: z.literal(false),
    unavailable: z.string(),
    source: z.string(),
    asOf: isoDate,
  }),
]);
export const balancesResponse = z.object({
  treasuryAccountId: z.string(),
  public: balance,
  confidential: balance,
});
export const sessionRequest = z.object({
  requestId: uuid,
  payload: intentPayload,
  summary: z.string(),
  expiresAt: isoDate,
});
export const sessionComplete = z.object({ status: z.string() });
export const fundingQuote = z.object({
  eventId: uuid,
  depositAddress: z.string(),
  amountToSend: units,
  amountToSendFormatted: z.string(),
  asset: z.string(),
  verification: z.string(),
  network: z.string(),
  deadline: isoDate,
  minimumReceived: z.string(),
  originId: z.string(),
  convertsToUsdc: z.boolean(),
  amountOut: units,
  amountOutFormatted: z.string(),
  /** 1Click's own USD figures. Unsigned, so display only. */
  amountInUsd: z.string().nullable(),
  amountOutUsd: z.string().nullable(),
  treasuryAccountId: z.string(),
  refundAddress: z.string(),
  /** The whole signed 1Click response, for the browser's check of its signature (gate A). */
  signedQuote: z.record(z.string(), z.unknown()),
  summary: z.string(),
});
export const shieldRequest = z.object({
  eventId: uuid,
  payload: intentPayload,
  amount: z.string(),
  summary: z.string(),
  expiresAt: isoDate,
});
export const shieldComplete = z.object({
  eventId: uuid,
  status: z.string(),
  intentHash: z.string().nullable(),
});
export const eventRefresh = z.object({ eventId: uuid, status: z.string(), statusHistory });

// --- Health ---
export const healthResponse = z.object({ status: z.literal("ok") });
export const readyResponse = z.object({ status: z.literal("ready") });

/** The API's error body, for every non-2xx JSON response. */
export const errorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

/** Every route the API serves. "csv" routes return text/csv, not JSON. */
export const ROUTES = {
  "GET /health": healthResponse,
  "GET /ready": readyResponse,
  "POST /auth/challenge": challengeResponse,
  "POST /auth/verify": verifyResponse,
  "POST /auth/logout": ok,
  "POST /auth/signup": accountState,
  "POST /auth/login": accountState,
  "POST /auth/verify-email": ok,
  "POST /auth/resend-verification": ok,
  "POST /auth/forgot-password": ok,
  "POST /auth/reset-password": ok,
  "POST /auth/change-password": ok,
  "POST /auth/wallet-link/challenge": challengeResponse,
  "POST /auth/wallet-link": verifyResponse,
  "GET /me": meResponse,
  "POST /orgs": organization,
  "GET /orgs/:orgId": organization,
  "GET /orgs/:orgId/members": membersResponse,
  "POST /orgs/:orgId/members": memberAdded,
  "PATCH /orgs/:orgId/members/:userId": memberRole,
  "POST /orgs/:orgId/members/:userId/remove": ok,
  "GET /orgs/:orgId/contractors": contractorsResponse,
  "POST /orgs/:orgId/contractors": contractor,
  "POST /orgs/:orgId/contractors/import": importResponse,
  "GET /orgs/:orgId/contractors/:contractorId": contractor,
  "PATCH /orgs/:orgId/contractors/:contractorId": contractor,
  "POST /orgs/:orgId/contractors/:contractorId/archive": contractor,
  "GET /orgs/:orgId/contractors/:contractorId/destinations": destinationsResponse,
  "POST /orgs/:orgId/contractors/:contractorId/destinations": destination,
  "POST /orgs/:orgId/contractors/:contractorId/destinations/:destinationId/recheck": destination,
  "POST /orgs/:orgId/contractors/:contractorId/destinations/:destinationId/approval-request":
    approvalRequest,
  "POST /orgs/:orgId/contractors/:contractorId/destinations/:destinationId/approval-request/:requestId/complete":
    headChange,
  "POST /orgs/:orgId/payees/:approvalId/revoke-request": revokeRequest,
  "POST /orgs/:orgId/payees/:approvalId/revoke-request/:requestId/complete": headChange,
  "POST /orgs/:orgId/contractors/:contractorId/invites": inviteResponse,
  "GET /orgs/:orgId/contractors/:contractorId/address-changes": addressChangesResponse,
  "POST /orgs/:orgId/contractors/:contractorId/address-changes/:requestId/apply":
    addressChangesResponse,
  "POST /portal/invites/accept": acceptResponse,
  "GET /portal/me": portalMe,
  "GET /portal/contractors/:contractorId/payslips": portalPayslips,
  "GET /portal/contractors/:contractorId/destinations": portalDestinations,
  "GET /portal/contractors/:contractorId/address-changes": addressChangesResponse,
  "POST /portal/contractors/:contractorId/address-change": addressChange,
  "GET /portal/contractors/:contractorId/balance": portalBalance,
  "POST /portal/contractors/:contractorId/session-request": sessionRequest,
  "POST /portal/contractors/:contractorId/session-request/:id/complete": sessionComplete,
  "GET /orgs/:orgId/payee-registry": payeeRegistryResponse,
  "GET /orgs/:orgId/payee-registry/history": payeeHistoryResponse,
  "GET /orgs/:orgId/settings": orgSettings,
  "PATCH /orgs/:orgId/settings": orgSettings,
  "GET /fx": fxResponse,
  "PATCH /portal/contractors/:contractorId/display-currency": displayCurrencyChoice,
  "GET /orgs/:orgId/payroll-schedule": scheduleResponse,
  "PUT /orgs/:orgId/payroll-schedule": scheduleResponse,
  "POST /orgs/:orgId/payroll-schedule/pause": scheduleResponse,
  "POST /orgs/:orgId/payroll-schedule/resume": scheduleResponse,
  "POST /orgs/:orgId/pay-runs": payRun,
  "GET /orgs/:orgId/pay-runs": payRunsResponse,
  "GET /orgs/:orgId/pay-runs/:payRunId": payRun,
  "POST /orgs/:orgId/pay-runs/:payRunId/items": itemCreated,
  "PATCH /orgs/:orgId/pay-runs/:payRunId/items/:itemId": itemCreated,
  "DELETE /orgs/:orgId/pay-runs/:payRunId/items/:itemId": ok,
  "POST /orgs/:orgId/pay-runs/:payRunId/prepare": payRun,
  "POST /orgs/:orgId/pay-runs/:payRunId/review": payRun,
  "POST /orgs/:orgId/pay-runs/:payRunId/approve": payRunApproved,
  "POST /orgs/:orgId/pay-runs/:payRunId/quote": payRun,
  "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request": signRequestResponse,
  "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request/:requestId/complete":
    signComplete,
  "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/retry": retryResponse,
  "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/acknowledge": ok,
  "GET /orgs/:orgId/ledger": ledgerResponse,
  "GET /orgs/:orgId/pay-runs/:payRunId/items/:itemId/payslip": payslipResponse,
  "GET /orgs/:orgId/exports/payouts.csv": "csv",
  "GET /orgs/:orgId/audit": auditResponse,
  "POST /orgs/:orgId/treasury/session-request": sessionRequest,
  "POST /orgs/:orgId/treasury/session-request/:id/complete": sessionComplete,
  "GET /orgs/:orgId/treasury/balances": balancesResponse,
  "POST /orgs/:orgId/treasury/funding-quote": fundingQuote,
  "POST /orgs/:orgId/treasury/shield-request": shieldRequest,
  "POST /orgs/:orgId/treasury/shield-request/:id/complete": shieldComplete,
  "POST /orgs/:orgId/treasury/events/:id/refresh": eventRefresh,
} as const satisfies Record<string, z.ZodType | "csv">;

export type RouteKey = keyof typeof ROUTES;
export type RouteResponse<K extends RouteKey> = (typeof ROUTES)[K] extends z.ZodType
  ? z.infer<(typeof ROUTES)[K]>
  : string;
