import {
  ATTEMPT_STATUSES,
  FAILURE_REASONS,
  MODES,
  NON_TERMINAL_ATTEMPT_STATUSES,
  PAY_RUN_STATUSES,
} from "@veylo/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const tuple = <T extends string>(values: readonly T[]) => values as unknown as [T, ...T[]];

export const modeEnum = pgEnum("mode", MODES);
export const payRunStatusEnum = pgEnum("pay_run_status", PAY_RUN_STATUSES);
export const attemptStatusEnum = pgEnum("attempt_status", ATTEMPT_STATUSES);
export const failureReasonEnum = pgEnum("failure_reason", FAILURE_REASONS);
export const membershipRoleEnum = pgEnum("membership_role", ["owner", "viewer", "accountant"]);
export const membershipStatusEnum = pgEnum("membership_status", ["active", "removed"]);
export const preparedByEnum = pgEnum("prepared_by", ["agent", "user"]);
export const payoutModeEnum = pgEnum("payout_mode", ["direct", "private"]);
export const destinationStatusEnum = pgEnum("destination_status", [
  "candidate",
  "active",
  "superseded",
]);
export const destinationCheckEnum = pgEnum("destination_check", [
  "accepted",
  "rejected",
  "route_unavailable",
  "check_failed",
]);
export const enteredByEnum = pgEnum("entered_by", ["owner", "contractor"]);
export const payeeRequestKindEnum = pgEnum("payee_request_kind", ["approve", "revoke"]);

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const moment = (name: string) => timestamp(name, { withTimezone: true });
/** Smallest units of an asset. Never a float or numeric string. */
const units = (name: string) => bigint(name, { mode: "bigint" });

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  nearAccountId: text("near_account_id").notNull().unique(),
  createdAt: createdAt(),
});

const orgId = () =>
  uuid("org_id")
    .notNull()
    .references(() => organizations.id);

export const memberships = pgTable(
  "memberships",
  {
    orgId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: membershipRoleEnum("role").notNull(),
    // Never deleted: pay runs reference memberships as their approver (L22).
    status: membershipStatusEnum("status").notNull().default("active"),
    removedAt: moment("removed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    check(
      "memberships_removed_at_iff_removed",
      sql`(${t.status} = 'removed') = (${t.removedAt} IS NOT NULL)`,
    ),
  ],
);

export const treasuries = pgTable("treasuries", {
  id: id(),
  orgId: orgId().unique(), // One per org for the MVP (ARCHITECTURE §10).
  nearAccountId: text("near_account_id").notNull(),
  createdAt: createdAt(),
});

export const contractors = pgTable(
  "contractors",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    email: text("email"),
    terms: jsonb("terms").notNull(),
    // Null until a first destination is accepted. One active mode per contractor (rule 8).
    payoutMode: payoutModeEnum("payout_mode"),
    status: text("status").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("contractors_org_id_idx").on(t.orgId),
    unique("contractors_org_id_id_unique").on(t.orgId, t.id),
    check("contractors_status_known", sql`${t.status} IN ('active', 'archived')`),
  ],
);

export const payoutDestinations = pgTable(
  "payout_destinations",
  {
    id: id(),
    orgId: orgId(),
    contractorId: uuid("contractor_id").notNull(),
    route: text("route").notNull(),
    payoutMode: payoutModeEnum("payout_mode").notNull(),
    chain: text("chain").notNull(),
    assetId: text("asset_id").notNull(),
    address: text("address").notNull(),
    validatedAt: moment("validated_at"),
    receivedPublicPayout: boolean("received_public_payout").notNull().default(false),
    confirmedAt: moment("confirmed_at"),
    controlProof: jsonb("control_proof"),
    // candidate: not yet accepted, or rejected. active: the one in use. superseded: replaced (L25).
    status: destinationStatusEnum("status").notNull().default("candidate"),
    supersededAt: moment("superseded_at"),
    checkStatus: destinationCheckEnum("check_status").notNull().default("check_failed"),
    checkReason: text("check_reason"),
    checkedAt: moment("checked_at"),
    feePreview: jsonb("fee_preview"),
    enteredBy: enteredByEnum("entered_by").notNull().default("owner"),
    // Contractor re-confirmation arrives with the contractor portal (L27).
    contractorConfirmedAt: moment("contractor_confirmed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("payout_destinations_org_id_idx").on(t.orgId),
    unique("payout_destinations_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("payout_destinations_one_active_per_contractor")
      .on(t.contractorId)
      .where(sql`${t.status} = 'active'`),
    check(
      "payout_destinations_superseded_at_iff_superseded",
      sql`(${t.status} = 'superseded') = (${t.supersededAt} IS NOT NULL)`,
    ),
    check(
      "payout_destinations_active_needs_accepted",
      sql`${t.status} <> 'active' OR ${t.checkStatus} = 'accepted'`,
    ),
    foreignKey({
      name: "payout_destinations_contractor_same_org",
      columns: [t.orgId, t.contractorId],
      foreignColumns: [contractors.orgId, contractors.id],
    }),
  ],
);

export const payeeApprovals = pgTable(
  "payee_approvals",
  {
    id: id(),
    orgId: orgId(),
    destinationId: uuid("destination_id").notNull(),
    version: integer("version").notNull(),
    payload: jsonb("payload").notNull(),
    // The exact text signed, and the name as it was then, so the browser can recompute it.
    message: text("message").notNull(),
    contractorName: text("contractor_name").notNull(),
    ownerAccountId: text("owner_account_id").notNull(),
    ownerPublicKey: text("owner_public_key").notNull(),
    signature: text("signature").notNull(),
    approvedAt: moment("approved_at").notNull(),
    expiresAt: moment("expires_at").notNull(),
    revokedAt: moment("revoked_at"),
  },
  (t) => [
    unique("payee_approvals_destination_version_unique").on(t.destinationId, t.version),
    unique("payee_approvals_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      name: "payee_approvals_destination_same_org",
      columns: [t.orgId, t.destinationId],
      foreignColumns: [payoutDestinations.orgId, payoutDestinations.id],
    }),
  ],
);

/** A pending approval or revocation: single-use, short-lived, holding exactly what must be signed. */
export const payeeRequests = pgTable(
  "payee_requests",
  {
    id: id(),
    orgId: orgId(),
    kind: payeeRequestKindEnum("kind").notNull(),
    destinationId: uuid("destination_id").notNull(),
    approvalId: uuid("approval_id"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    canonicalRecord: text("canonical_record"),
    recordHash: text("record_hash"),
    approvalMessage: text("approval_message"),
    contractorName: text("contractor_name"),
    approvalNonce: text("approval_nonce").unique(),
    approvedAt: moment("approved_at"),
    expiresRecordAt: moment("expires_record_at"),
    approvalVersion: integer("approval_version"),
    headVersion: integer("head_version").notNull(),
    headMessage: text("head_message").notNull(),
    headNonce: text("head_nonce").notNull().unique(),
    headRecordHashes: jsonb("head_record_hashes").notNull(),
    headSignedAt: moment("head_signed_at").notNull(),
    expiresAt: moment("expires_at").notNull(),
    usedAt: moment("used_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("payee_requests_org_id_idx").on(t.orgId),
    foreignKey({
      name: "payee_requests_destination_same_org",
      columns: [t.orgId, t.destinationId],
      foreignColumns: [payoutDestinations.orgId, payoutDestinations.id],
    }),
    foreignKey({
      name: "payee_requests_approval_same_org",
      columns: [t.orgId, t.approvalId],
      foreignColumns: [payeeApprovals.orgId, payeeApprovals.id],
    }),
  ],
);

export const payeeRegistryHeads = pgTable(
  "payee_registry_heads",
  {
    id: id(),
    orgId: orgId(),
    version: integer("version").notNull(),
    activeSetHash: text("active_set_hash").notNull(),
    payload: jsonb("payload").notNull(),
    ownerPublicKey: text("owner_public_key").notNull(),
    signature: text("signature").notNull(),
    signedAt: moment("signed_at").notNull(),
  },
  (t) => [unique("payee_registry_heads_org_version_unique").on(t.orgId, t.version)],
);

export const payRuns = pgTable(
  "pay_runs",
  {
    id: id(),
    orgId: orgId(),
    period: text("period").notNull(),
    status: payRunStatusEnum("status").notNull(),
    preparedBy: preparedByEnum("prepared_by").notNull(),
    approvedBy: uuid("approved_by"),
    approvedAt: moment("approved_at"),
    totalAmountUsdc: units("total_amount_usdc").notNull(),
    mode: modeEnum("mode").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("pay_runs_org_id_idx").on(t.orgId),
    unique("pay_runs_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      name: "pay_runs_approver_is_member",
      columns: [t.orgId, t.approvedBy],
      foreignColumns: [memberships.orgId, memberships.userId],
    }),
    check("pay_runs_total_non_negative", sql`${t.totalAmountUsdc} >= 0`),
  ],
);

export const payRunItems = pgTable(
  "pay_run_items",
  {
    id: id(),
    orgId: orgId(),
    payRunId: uuid("pay_run_id").notNull(),
    contractorId: uuid("contractor_id").notNull(),
    // Set when the run is prepared: the contractor's active destination at that moment.
    destinationId: uuid("destination_id"),
    amountUsdc: units("amount_usdc").notNull(),
    basis: jsonb("basis").notNull(),
    flags: jsonb("flags").notNull().default([]),
    feePreview: jsonb("fee_preview"),
    mode: modeEnum("mode").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("pay_run_items_pay_run_id_idx").on(t.payRunId),
    unique("pay_run_items_one_per_contractor").on(t.payRunId, t.contractorId),
    unique("pay_run_items_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      name: "pay_run_items_pay_run_same_org",
      columns: [t.orgId, t.payRunId],
      foreignColumns: [payRuns.orgId, payRuns.id],
    }),
    foreignKey({
      name: "pay_run_items_contractor_same_org",
      columns: [t.orgId, t.contractorId],
      foreignColumns: [contractors.orgId, contractors.id],
    }),
    foreignKey({
      name: "pay_run_items_destination_same_org",
      columns: [t.orgId, t.destinationId],
      foreignColumns: [payoutDestinations.orgId, payoutDestinations.id],
    }),
    check("pay_run_items_amount_non_negative", sql`${t.amountUsdc} >= 0`),
  ],
);

const nonTerminalList = sql.raw(
  tuple(NON_TERMINAL_ATTEMPT_STATUSES)
    .map((status) => `'${status}'`)
    .join(", "),
);

export const payoutAttempts = pgTable(
  "payout_attempts",
  {
    id: id(),
    orgId: orgId(),
    lineItemId: uuid("line_item_id").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    quoteRequest: jsonb("quote_request"),
    quote: jsonb("quote"),
    // Null until quoted. Postgres allows many nulls under a unique constraint.
    depositAddress: text("deposit_address"),
    correlationId: text("correlation_id"),
    // The quote's own deadline. The signed message has carried this same value (S-E2).
    deadline: moment("deadline"),
    // What we asked for: through 1Click this one governs generate and submit (L34).
    requestedDeadline: moment("requested_deadline"),
    // Known once the intent is generated (slice 5b).
    signedMessageDeadline: moment("signed_message_deadline"),
    // null, "submitted", "rejected" or "uncertain" (network, 5xx, timeout: resolved by a job).
    submitOutcome: text("submit_outcome"),
    submitAttempts: integer("submit_attempts").notNull().default(0),
    statusCheckedAt: moment("status_checked_at"),
    terminalAt: moment("terminal_at"),
    // Past its requested deadline with no record at 1Click (L32, L34).
    expiredUnsubmitted: boolean("expired_unsubmitted").notNull().default(false),
    // The signed payload: a bearer authorization until its message deadline (L33). Encrypted, and
    // deleted once it can do nothing more.
    encryptedSignedPayload: text("encrypted_signed_payload"),
    payloadDeletedAt: moment("payload_deleted_at"),
    balanceUnconfirmed: boolean("balance_unconfirmed"),
    observedBalance: text("observed_balance"),
    failureDetail: text("failure_detail"),
    lastStatus: jsonb("last_status"),
    minAmountIn: units("min_amount_in"),
    amountIn: units("amount_in"),
    fees: jsonb("fees"),
    intentHash: text("intent_hash"),
    status: attemptStatusEnum("status").notNull(),
    failureReason: failureReasonEnum("failure_reason"),
    statusHistory: jsonb("status_history").notNull().default([]),
    settlementIntentHashes: jsonb("settlement_intent_hashes").notNull().default([]),
    nearTxHashes: jsonb("near_tx_hashes").notNull().default([]),
    destinationTxHash: text("destination_tx_hash"),
    refundedAmount: units("refunded_amount"),
    reconciledAt: moment("reconciled_at"),
    mode: modeEnum("mode").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "payout_attempts_line_item_same_org",
      columns: [t.orgId, t.lineItemId],
      foreignColumns: [payRunItems.orgId, payRunItems.id],
    }),
    check(
      "payout_attempts_failure_reason_iff_failed",
      sql`(${t.status} = 'FAILED') = (${t.failureReason} IS NOT NULL)`,
    ),
    unique("payout_attempts_deposit_address_unique").on(t.depositAddress),
    unique("payout_attempts_org_id_id_unique").on(t.orgId, t.id),
    unique("payout_attempts_line_item_attempt_unique").on(t.lineItemId, t.attemptNo),
    uniqueIndex("payout_attempts_one_non_terminal_per_item")
      .on(t.lineItemId)
      .where(sql`${t.status} IN (${nonTerminalList})`),
    check("payout_attempts_attempt_no_positive", sql`${t.attemptNo} >= 1`),
    check(
      "payout_attempts_amounts_non_negative",
      sql`${t.minAmountIn} >= 0 AND ${t.amountIn} >= 0 AND ${t.refundedAmount} >= 0`,
    ),
  ],
);

/** Single-use sign-in challenges. Not tenant-scoped: they exist before any session. */
export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: id(),
    nonce: text("nonce").notNull().unique(),
    accountId: text("account_id").notNull(),
    message: text("message").notNull(),
    expiresAt: moment("expires_at").notNull(),
    usedAt: moment("used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("auth_challenges_expires_at_idx").on(t.expiresAt)],
);

/** Holds only the SHA-256 of the session token, so a database leak yields no usable session. */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: moment("created_at").notNull().defaultNow(),
    expiresAt: moment("expires_at").notNull(),
    revokedAt: moment("revoked_at"),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const treasuryEventTypeEnum = pgEnum("treasury_event_type", ["fund", "shield"]);
export const oneClickSessionStatusEnum = pgEnum("oneclick_session_status", [
  "active",
  "needs_resign",
]);

/** ARCHITECTURE §6.1: every funding and shield step, with its quote and hashes. */
export const treasuryEvents = pgTable(
  "treasury_events",
  {
    id: id(),
    orgId: orgId(),
    type: treasuryEventTypeEnum("type").notNull(),
    originAsset: text("origin_asset").notNull(),
    // Non-USDC origins have 18 decimals, past bigint's range (L20).
    originAmount: numeric("origin_amount", { precision: 78, scale: 0 }).notNull(),
    destinationAmount: units("destination_amount").notNull(),
    quote: jsonb("quote").notNull(),
    correlationId: text("correlation_id").notNull(),
    depositAddress: text("deposit_address").notNull().unique(),
    status: text("status").notNull(),
    statusHistory: jsonb("status_history").notNull().default([]),
    lastStatus: jsonb("last_status"),
    payload: jsonb("payload"),
    intentHash: text("intent_hash"),
    expiresAt: moment("expires_at"),
    mode: modeEnum("mode").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("treasury_events_org_id_idx").on(t.orgId),
    unique("treasury_events_org_id_id_unique").on(t.orgId, t.id),
    check(
      "treasury_events_amounts_non_negative",
      sql`${t.originAmount} >= 0 AND ${t.destinationAmount} >= 0`,
    ),
  ],
);

/** Holds only ciphertext of the data key, wrapped by SESSION_ENCRYPTION_KEY (L31). */
export const orgDataKeys = pgTable("org_data_keys", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id),
  wrappedKey: text("wrapped_key").notNull(),
  createdAt: createdAt(),
});

export const treasurySessionRequests = pgTable(
  "treasury_session_requests",
  {
    id: id(),
    orgId: orgId(),
    message: text("message").notNull(),
    nonce: text("nonce").notNull().unique(),
    recipient: text("recipient").notNull(),
    expiresAt: moment("expires_at").notNull(),
    usedAt: moment("used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("treasury_session_requests_org_id_idx").on(t.orgId)],
);

/** One 1Click User-Session per org. Tokens are encrypted, bound to this row (T-10, L30). */
export const sessions1Click = pgTable("sessions_1click", {
  id: uuid("id").primaryKey(),
  orgId: orgId().unique(),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  accessExpiresAt: moment("access_expires_at").notNull(),
  refreshExpiresAt: moment("refresh_expires_at").notNull(),
  status: oneClickSessionStatusEnum("status").notNull(),
  createdAt: createdAt(),
});

/** A generated payload awaiting the treasury's signature. Single-use; expires at the requested deadline. */
export const signRequests = pgTable(
  "sign_requests",
  {
    id: id(),
    orgId: orgId(),
    attemptId: uuid("attempt_id").notNull(),
    payload: jsonb("payload").notNull(),
    expiresAt: moment("expires_at").notNull(),
    usedAt: moment("used_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "sign_requests_attempt_same_org",
      columns: [t.orgId, t.attemptId],
      foreignColumns: [payoutAttempts.orgId, payoutAttempts.id],
    }),
  ],
);

/** Funds a signed, unsettled payload could still move (L34). Subtracted from the available balance. */
export const encumbrances = pgTable(
  "encumbrances",
  {
    id: id(),
    orgId: orgId(),
    attemptId: uuid("attempt_id").notNull().unique(),
    amount: units("amount").notNull(),
    until: moment("until").notNull(),
    releasedAt: moment("released_at"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("encumbrances_org_id_idx").on(t.orgId),
    foreignKey({
      name: "encumbrances_attempt_same_org",
      columns: [t.orgId, t.attemptId],
      foreignColumns: [payoutAttempts.orgId, payoutAttempts.id],
    }),
    check("encumbrances_amount_positive", sql`${t.amount} > 0`),
    check(
      "encumbrances_reason_iff_released",
      sql`(${t.releasedAt} IS NULL) = (${t.reason} IS NULL)`,
    ),
  ],
);

/**
 * Append-only. A trigger in the migrations blocks UPDATE, DELETE and TRUNCATE.
 * org_id is null only for events with no organization: sign-in and logout.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    orgId: uuid("org_id").references(() => organizations.id),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    detailsHash: text("details_hash"),
    txHash: text("tx_hash"),
    at: moment("at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_org_id_idx").on(t.orgId),
    check(
      "audit_log_org_required_except_auth",
      sql`${t.orgId} IS NOT NULL OR ${t.action} LIKE 'auth.%'`,
    ),
  ],
);
