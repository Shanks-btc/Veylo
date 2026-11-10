// Every tenant query takes orgId and filters on it (ARCHITECTURE §9, T-8). Route code reaches
// tenant tables only through these functions.
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  max,
  ne,
  or,
  sql,
  sum,
  type SQL,
} from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

const {
  encumbrances,
  signRequests,
  payRuns,
  payRunItems,
  payoutAttempts,
  orgDataKeys,
  sessions1Click,
  treasuryEvents,
  treasurySessionRequests,
  payeeApprovals,
  payeeRegistryHeads,
  payeeRequests,
  contractors,
  payoutDestinations,
  auditLog,
  authChallenges,
  memberships,
  organizations,
  sessions,
  treasuries,
  users,
} = schema;

// The driver differs between PGlite (tests) and pg (production), and a transaction is also a Db.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;
export type MembershipRole = (typeof schema.membershipRoleEnum.enumValues)[number];

// --- Users, challenges and sessions: not tenant-scoped ---

export async function findOrCreateUser(db: Db, nearAccountId: string) {
  await db.insert(users).values({ nearAccountId }).onConflictDoNothing();
  const [user] = await db.select().from(users).where(eq(users.nearAccountId, nearAccountId));
  if (!user) throw new Error("user was not created");
  return user;
}

export async function insertChallenge(
  db: Db,
  values: { nonce: string; accountId: string; message: string; expiresAt: Date },
) {
  await db.insert(authChallenges).values(values);
}

/** Deletes at most `limit` challenges that expired before `cutoff`, oldest first. */
export async function deleteExpiredChallenges(db: Db, cutoff: Date, limit = 500) {
  const batch = db
    .select({ id: authChallenges.id })
    .from(authChallenges)
    .where(lt(authChallenges.expiresAt, cutoff))
    .orderBy(asc(authChallenges.expiresAt))
    .limit(limit);
  await db.delete(authChallenges).where(inArray(authChallenges.id, batch));
}

export async function findChallenge(db: Db, nonce: string) {
  const [row] = await db.select().from(authChallenges).where(eq(authChallenges.nonce, nonce));
  return row;
}

/**
 * The single point that spends a challenge. One UPDATE decides, so only one caller can get a row
 * back however many verify at once.
 */
export async function consumeChallenge(
  db: Db,
  values: { nonce: string; accountId: string; now: Date },
): Promise<boolean> {
  const rows = await db
    .update(authChallenges)
    .set({ usedAt: values.now })
    .where(
      and(
        eq(authChallenges.nonce, values.nonce),
        eq(authChallenges.accountId, values.accountId),
        isNull(authChallenges.usedAt),
        gt(authChallenges.expiresAt, values.now),
      ),
    )
    .returning({ id: authChallenges.id });
  return rows.length === 1;
}

export async function insertSession(
  db: Db,
  values: { tokenHash: string; userId: string; createdAt: Date; expiresAt: Date },
) {
  const [row] = await db.insert(sessions).values(values).returning({ id: sessions.id });
  if (!row) throw new Error("session was not created");
  return row.id;
}

export async function findActiveSession(db: Db, tokenHash: string, now: Date) {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      nearAccountId: users.nearAccountId,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    );
  return row;
}

export async function revokeSession(db: Db, sessionId: string, now: Date) {
  await db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, sessionId));
}

/** A user's own organizations, for /me. */
export async function listActiveMembershipsForUser(db: Db, userId: string) {
  return db
    .select({
      orgId: memberships.orgId,
      orgName: organizations.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")))
    .orderBy(asc(memberships.createdAt));
}

// --- Tenant-scoped: orgId is always required ---

export async function createOrganization(
  db: Db,
  values: { name: string; treasuryAccountId: string; ownerUserId: string },
) {
  const [org] = await db.insert(organizations).values({ name: values.name }).returning();
  if (!org) throw new Error("organization was not created");
  await db.insert(treasuries).values({ orgId: org.id, nearAccountId: values.treasuryAccountId });
  await db.insert(memberships).values({ orgId: org.id, userId: values.ownerUserId, role: "owner" });
  return org;
}

export async function getOrganization(db: Db, orgId: string) {
  const [row] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      treasuryAccountId: treasuries.nearAccountId,
    })
    .from(organizations)
    .innerJoin(treasuries, eq(treasuries.orgId, organizations.id))
    .where(eq(organizations.id, orgId));
  return row;
}

export async function getMembership(db: Db, orgId: string, userId: string) {
  const [row] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  return row;
}

/** Removed members count as non-members everywhere (L22), so callers normally want this one. */
export async function getActiveMembership(db: Db, orgId: string, userId: string) {
  const row = await getMembership(db, orgId, userId);
  return row?.status === "active" ? row : undefined;
}

export async function listActiveMembers(db: Db, orgId: string) {
  return db
    .select({
      userId: memberships.userId,
      nearAccountId: users.nearAccountId,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active")))
    .orderBy(asc(memberships.createdAt));
}

/** Returns false if the membership already exists. */
export async function insertMembership(
  db: Db,
  orgId: string,
  userId: string,
  role: MembershipRole,
): Promise<boolean> {
  const rows = await db
    .insert(memberships)
    .values({ orgId, userId, role })
    .onConflictDoNothing()
    .returning({ userId: memberships.userId });
  return rows.length === 1;
}

export async function reactivateMembership(
  db: Db,
  orgId: string,
  userId: string,
  role: MembershipRole,
) {
  await db
    .update(memberships)
    .set({ status: "active", removedAt: null, role })
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
}

export async function setMemberRole(db: Db, orgId: string, userId: string, role: MembershipRole) {
  await db
    .update(memberships)
    .set({ role })
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
      ),
    );
}

export async function markMemberRemoved(db: Db, orgId: string, userId: string, now: Date) {
  await db
    .update(memberships)
    .set({ status: "removed", removedAt: now })
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.userId, userId),
        eq(memberships.status, "active"),
      ),
    );
}

/**
 * Locks the org's active owners for the transaction. Two concurrent demotions or removals then run
 * one after the other, so they can't together remove the last owner.
 */
export async function lockActiveOwners(db: Db, orgId: string) {
  return db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.role, "owner"),
        eq(memberships.status, "active"),
      ),
    )
    .orderBy(asc(memberships.userId)) // A fixed lock order, so two transactions can't deadlock.
    .for("update");
}

type ContractorFields = { name: string; email: string | null; terms: unknown };

export async function insertContractor(db: Db, orgId: string, values: ContractorFields) {
  const [row] = await db
    .insert(contractors)
    .values({ orgId, status: "active", ...values })
    .returning();
  if (!row) throw new Error("contractor was not created");
  return row;
}

export async function listContractors(db: Db, orgId: string) {
  return db
    .select()
    .from(contractors)
    .where(eq(contractors.orgId, orgId))
    .orderBy(asc(contractors.createdAt));
}

export async function getContractor(db: Db, orgId: string, contractorId: string) {
  const [row] = await db
    .select()
    .from(contractors)
    .where(and(eq(contractors.orgId, orgId), eq(contractors.id, contractorId)));
  return row;
}

export async function updateContractor(
  db: Db,
  orgId: string,
  contractorId: string,
  values: Partial<ContractorFields>,
) {
  const [row] = await db
    .update(contractors)
    .set(values)
    .where(and(eq(contractors.orgId, orgId), eq(contractors.id, contractorId)))
    .returning();
  return row;
}

export async function archiveContractor(db: Db, orgId: string, contractorId: string) {
  const [row] = await db
    .update(contractors)
    .set({ status: "archived" })
    .where(and(eq(contractors.orgId, orgId), eq(contractors.id, contractorId)))
    .returning();
  return row;
}

type DestinationCheck = {
  checkStatus: "accepted" | "rejected" | "route_unavailable" | "check_failed";
  checkReason: string | null;
  feePreview: unknown;
  checkedAt: Date;
};

export async function insertDestination(
  db: Db,
  orgId: string,
  contractorId: string,
  values: DestinationCheck & {
    route: string;
    chain: string;
    assetId: string;
    payoutMode: "direct" | "private";
    address: string;
  },
) {
  const [row] = await db
    .insert(payoutDestinations)
    .values({ orgId, contractorId, ...values })
    .returning();
  if (!row) throw new Error("destination was not created");
  return row;
}

export async function listDestinations(db: Db, orgId: string, contractorId: string) {
  return db
    .select()
    .from(payoutDestinations)
    .where(
      and(eq(payoutDestinations.orgId, orgId), eq(payoutDestinations.contractorId, contractorId)),
    )
    .orderBy(asc(payoutDestinations.createdAt), asc(payoutDestinations.id));
}

export async function getDestination(
  db: Db,
  orgId: string,
  contractorId: string,
  destinationId: string,
) {
  const [row] = await db
    .select()
    .from(payoutDestinations)
    .where(
      and(
        eq(payoutDestinations.orgId, orgId),
        eq(payoutDestinations.contractorId, contractorId),
        eq(payoutDestinations.id, destinationId),
      ),
    );
  return row;
}

/** Records a recheck. Returns nothing if it's no longer a failed candidate. */
export async function recordDestinationCheck(
  db: Db,
  orgId: string,
  contractorId: string,
  destinationId: string,
  check: DestinationCheck,
) {
  const [row] = await db
    .update(payoutDestinations)
    .set(check)
    .where(
      and(
        eq(payoutDestinations.orgId, orgId),
        eq(payoutDestinations.contractorId, contractorId),
        eq(payoutDestinations.id, destinationId),
        eq(payoutDestinations.status, "candidate"),
        inArray(payoutDestinations.checkStatus, ["check_failed", "route_unavailable"]),
      ),
    )
    .returning();
  return row;
}

/**
 * Makes one accepted destination the contractor's only live one, and sets their payout mode.
 * Locks the contractor first, so concurrent changes run in turn. Returns what was superseded.
 */
export async function promoteDestination(
  db: Db,
  orgId: string,
  contractorId: string,
  destinationId: string,
  payoutMode: "direct" | "private",
  now: Date,
): Promise<string[]> {
  await db
    .select({ id: contractors.id })
    .from(contractors)
    .where(and(eq(contractors.orgId, orgId), eq(contractors.id, contractorId)))
    .for("update");
  const superseded = await db
    .update(payoutDestinations)
    .set({ status: "superseded", supersededAt: now })
    .where(
      and(
        eq(payoutDestinations.orgId, orgId),
        eq(payoutDestinations.contractorId, contractorId),
        ne(payoutDestinations.id, destinationId),
        ne(payoutDestinations.status, "superseded"),
      ),
    )
    .returning({ id: payoutDestinations.id });
  await db
    .update(payoutDestinations)
    .set({ status: "active" })
    .where(and(eq(payoutDestinations.orgId, orgId), eq(payoutDestinations.id, destinationId)));
  await db
    .update(contractors)
    .set({ payoutMode })
    .where(and(eq(contractors.orgId, orgId), eq(contractors.id, contractorId)));
  return superseded.map((s) => s.id);
}

// --- Payee registry. The database is untrusted under T-2: the browser re-verifies all of it (L16). ---

export async function getCurrentHead(db: Db, orgId: string) {
  const [row] = await db
    .select()
    .from(payeeRegistryHeads)
    .where(eq(payeeRegistryHeads.orgId, orgId))
    .orderBy(desc(payeeRegistryHeads.version))
    .limit(1);
  return row;
}

export async function insertHead(db: Db, values: typeof payeeRegistryHeads.$inferInsert) {
  await db.insert(payeeRegistryHeads).values(values);
}

export async function maxApprovalVersion(db: Db, orgId: string, destinationId: string) {
  const [row] = await db
    .select({ version: max(payeeApprovals.version) })
    .from(payeeApprovals)
    .where(and(eq(payeeApprovals.orgId, orgId), eq(payeeApprovals.destinationId, destinationId)));
  return row?.version ?? 0;
}

export async function insertApproval(db: Db, values: typeof payeeApprovals.$inferInsert) {
  const [row] = await db.insert(payeeApprovals).values(values).returning();
  if (!row) throw new Error("approval was not created");
  return row;
}

export async function getApproval(db: Db, orgId: string, approvalId: string) {
  const [row] = await db
    .select()
    .from(payeeApprovals)
    .where(and(eq(payeeApprovals.orgId, orgId), eq(payeeApprovals.id, approvalId)));
  return row;
}

export async function markApprovalRevoked(db: Db, orgId: string, approvalId: string, now: Date) {
  await db
    .update(payeeApprovals)
    .set({ revokedAt: now })
    .where(and(eq(payeeApprovals.orgId, orgId), eq(payeeApprovals.id, approvalId)));
}

export async function listApprovalsForContractor(db: Db, orgId: string, contractorId: string) {
  return db
    .select({
      id: payeeApprovals.id,
      destinationId: payeeApprovals.destinationId,
      destinationStatus: payoutDestinations.status,
      version: payeeApprovals.version,
      payload: payeeApprovals.payload,
      ownerAccountId: payeeApprovals.ownerAccountId,
      ownerPublicKey: payeeApprovals.ownerPublicKey,
      signature: payeeApprovals.signature,
      message: payeeApprovals.message,
      contractorName: payeeApprovals.contractorName,
      expiresAt: payeeApprovals.expiresAt,
      revokedAt: payeeApprovals.revokedAt,
    })
    .from(payeeApprovals)
    .innerJoin(payoutDestinations, eq(payoutDestinations.id, payeeApprovals.destinationId))
    .where(and(eq(payeeApprovals.orgId, orgId), eq(payoutDestinations.contractorId, contractorId)));
}

/** The approvals in a head's set. An empty list needs no query. */
export async function listApprovalsByHash(db: Db, orgId: string, recordHashes: readonly string[]) {
  if (recordHashes.length === 0) return [];
  const rows = await db.select().from(payeeApprovals).where(eq(payeeApprovals.orgId, orgId));
  const wanted = new Set(recordHashes);
  return rows.filter((row) => wanted.has((row.payload as { recordHash: string }).recordHash));
}

export async function insertPayeeRequest(db: Db, values: typeof payeeRequests.$inferInsert) {
  const [row] = await db.insert(payeeRequests).values(values).returning();
  if (!row) throw new Error("request was not created");
  return row;
}

export async function getPayeeRequest(db: Db, orgId: string, requestId: string) {
  const [row] = await db
    .select()
    .from(payeeRequests)
    .where(and(eq(payeeRequests.orgId, orgId), eq(payeeRequests.id, requestId)));
  return row;
}

/** One UPDATE decides, so only one caller can spend a request's nonces. */
export async function consumePayeeRequest(db: Db, orgId: string, requestId: string, now: Date) {
  const rows = await db
    .update(payeeRequests)
    .set({ usedAt: now })
    .where(
      and(
        eq(payeeRequests.orgId, orgId),
        eq(payeeRequests.id, requestId),
        isNull(payeeRequests.usedAt),
        gt(payeeRequests.expiresAt, now),
      ),
    )
    .returning({ id: payeeRequests.id });
  return rows.length === 1;
}

export async function lockDestination(db: Db, orgId: string, destinationId: string) {
  const [row] = await db
    .select()
    .from(payoutDestinations)
    .where(and(eq(payoutDestinations.orgId, orgId), eq(payoutDestinations.id, destinationId)))
    .for("update");
  return row;
}

export async function getActiveMembershipByAccount(db: Db, orgId: string, nearAccountId: string) {
  const [row] = await db
    .select({ role: memberships.role, userId: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(users.nearAccountId, nearAccountId),
        eq(memberships.status, "active"),
      ),
    );
  return row;
}

// --- Treasury ---

/** The org's wrapped data key, created on first use. Concurrent callers end up with the same one. */
export async function getOrCreateWrappedDataKey(db: Db, orgId: string, create: () => string) {
  const read = async () =>
    (await db.select().from(orgDataKeys).where(eq(orgDataKeys.orgId, orgId)))[0]?.wrappedKey;
  const existing = await read();
  if (existing) return existing;
  await db.insert(orgDataKeys).values({ orgId, wrappedKey: create() }).onConflictDoNothing();
  const created = await read();
  if (!created) throw new Error("data key was not created");
  return created;
}

export async function insertTreasurySessionRequest(
  db: Db,
  values: typeof treasurySessionRequests.$inferInsert,
) {
  const [row] = await db.insert(treasurySessionRequests).values(values).returning();
  if (!row) throw new Error("request was not created");
  return row;
}

export async function getTreasurySessionRequest(db: Db, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(treasurySessionRequests)
    .where(and(eq(treasurySessionRequests.orgId, orgId), eq(treasurySessionRequests.id, id)));
  return row;
}

export async function consumeTreasurySessionRequest(db: Db, orgId: string, id: string, now: Date) {
  const rows = await db
    .update(treasurySessionRequests)
    .set({ usedAt: now })
    .where(
      and(
        eq(treasurySessionRequests.orgId, orgId),
        eq(treasurySessionRequests.id, id),
        isNull(treasurySessionRequests.usedAt),
        gt(treasurySessionRequests.expiresAt, now),
      ),
    )
    .returning({ id: treasurySessionRequests.id });
  return rows.length === 1;
}

export async function findOneClickSession(db: Db, orgId: string) {
  const [row] = await db.select().from(sessions1Click).where(eq(sessions1Click.orgId, orgId));
  return row;
}

export async function saveOneClickSession(db: Db, values: typeof sessions1Click.$inferInsert) {
  await db
    .insert(sessions1Click)
    .values(values)
    .onConflictDoUpdate({
      target: sessions1Click.orgId,
      set: {
        encryptedAccessToken: values.encryptedAccessToken,
        encryptedRefreshToken: values.encryptedRefreshToken,
        accessExpiresAt: values.accessExpiresAt,
        refreshExpiresAt: values.refreshExpiresAt,
        status: values.status,
      },
    });
}

export async function updateOneClickAccessToken(
  db: Db,
  orgId: string,
  values: { encryptedAccessToken: string; accessExpiresAt: Date },
) {
  await db.update(sessions1Click).set(values).where(eq(sessions1Click.orgId, orgId));
}

export async function markOneClickSessionNeedsResign(db: Db, orgId: string) {
  await db
    .update(sessions1Click)
    .set({ status: "needs_resign" })
    .where(eq(sessions1Click.orgId, orgId));
}

export async function insertTreasuryEvent(db: Db, values: typeof treasuryEvents.$inferInsert) {
  const [row] = await db.insert(treasuryEvents).values(values).returning();
  if (!row) throw new Error("event was not created");
  return row;
}

export async function getTreasuryEvent(db: Db, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(treasuryEvents)
    .where(and(eq(treasuryEvents.orgId, orgId), eq(treasuryEvents.id, id)));
  return row;
}

export async function updateTreasuryEvent(
  db: Db,
  orgId: string,
  id: string,
  values: Partial<typeof treasuryEvents.$inferInsert>,
) {
  await db
    .update(treasuryEvents)
    .set(values)
    .where(and(eq(treasuryEvents.orgId, orgId), eq(treasuryEvents.id, id)));
}

/** One UPDATE decides, so one signature can only ever be submitted once (rule 3). */
export async function claimShieldEvent(db: Db, orgId: string, id: string) {
  const rows = await db
    .update(treasuryEvents)
    .set({ status: "SUBMITTING" })
    .where(
      and(
        eq(treasuryEvents.orgId, orgId),
        eq(treasuryEvents.id, id),
        eq(treasuryEvents.status, "AWAITING_SIGNATURE"),
      ),
    )
    .returning({ id: treasuryEvents.id });
  return rows.length === 1;
}

// --- Pay runs ---

export async function insertPayRun(
  db: Db,
  values: { orgId: string; period: string; mode: "live" | "simulated" },
) {
  const [row] = await db
    .insert(payRuns)
    .values({ ...values, status: "Draft", preparedBy: "user", totalAmountUsdc: 0n })
    .returning();
  if (!row) throw new Error("pay run was not created");
  return row;
}

export async function listPayRuns(db: Db, orgId: string) {
  return db.select().from(payRuns).where(eq(payRuns.orgId, orgId)).orderBy(desc(payRuns.createdAt));
}

export async function getPayRun(db: Db, orgId: string, payRunId: string) {
  const [row] = await db
    .select()
    .from(payRuns)
    .where(and(eq(payRuns.orgId, orgId), eq(payRuns.id, payRunId)));
  return row;
}

type RunStatus = (typeof schema.payRunStatusEnum.enumValues)[number];

/** Moves a run only if it's still in the expected status. Returns false if it moved meanwhile. */
export async function setPayRunStatus(
  db: Db,
  orgId: string,
  payRunId: string,
  from: RunStatus,
  to: RunStatus,
  totalAmountUsdc?: bigint,
) {
  const rows = await db
    .update(payRuns)
    .set({ status: to, ...(totalAmountUsdc === undefined ? {} : { totalAmountUsdc }) })
    .where(and(eq(payRuns.orgId, orgId), eq(payRuns.id, payRunId), eq(payRuns.status, from)))
    .returning({ id: payRuns.id });
  return rows.length === 1;
}

export async function approvePayRun(
  db: Db,
  orgId: string,
  payRunId: string,
  approvedBy: string,
  at: Date,
) {
  const rows = await db
    .update(payRuns)
    .set({ status: "Quoting", approvedBy, approvedAt: at })
    .where(and(eq(payRuns.orgId, orgId), eq(payRuns.id, payRunId), eq(payRuns.status, "InReview")))
    .returning({ id: payRuns.id });
  return rows.length === 1;
}

export async function insertPayRunItem(db: Db, values: typeof payRunItems.$inferInsert) {
  const [row] = await db.insert(payRunItems).values(values).onConflictDoNothing().returning();
  return row;
}

export async function listPayRunItems(db: Db, orgId: string, payRunId: string) {
  return db
    .select()
    .from(payRunItems)
    .where(and(eq(payRunItems.orgId, orgId), eq(payRunItems.payRunId, payRunId)))
    .orderBy(asc(payRunItems.createdAt), asc(payRunItems.id));
}

export async function getPayRunItem(db: Db, orgId: string, payRunId: string, itemId: string) {
  const [row] = await db
    .select()
    .from(payRunItems)
    .where(
      and(
        eq(payRunItems.orgId, orgId),
        eq(payRunItems.payRunId, payRunId),
        eq(payRunItems.id, itemId),
      ),
    );
  return row;
}

export async function updatePayRunItem(
  db: Db,
  orgId: string,
  itemId: string,
  values: Partial<typeof payRunItems.$inferInsert>,
) {
  await db
    .update(payRunItems)
    .set(values)
    .where(and(eq(payRunItems.orgId, orgId), eq(payRunItems.id, itemId)));
}

export async function deletePayRunItem(db: Db, orgId: string, payRunId: string, itemId: string) {
  const rows = await db
    .delete(payRunItems)
    .where(
      and(
        eq(payRunItems.orgId, orgId),
        eq(payRunItems.payRunId, payRunId),
        eq(payRunItems.id, itemId),
      ),
    )
    .returning({ id: payRunItems.id });
  return rows.length === 1;
}

export async function listAttemptsForItems(db: Db, orgId: string, itemIds: readonly string[]) {
  if (itemIds.length === 0) return [];
  return db
    .select()
    .from(payoutAttempts)
    .where(and(eq(payoutAttempts.orgId, orgId), inArray(payoutAttempts.lineItemId, [...itemIds])));
}

/** Returns nothing if the item already has a non-terminal attempt (the unique index decides). */
export async function insertPayoutAttempt(db: Db, values: typeof payoutAttempts.$inferInsert) {
  const [row] = await db.insert(payoutAttempts).values(values).onConflictDoNothing().returning();
  return row;
}

export async function updatePayoutAttempt(
  db: Db,
  orgId: string,
  attemptId: string,
  values: Partial<typeof payoutAttempts.$inferInsert>,
) {
  await db
    .update(payoutAttempts)
    .set(values)
    .where(and(eq(payoutAttempts.orgId, orgId), eq(payoutAttempts.id, attemptId)));
}

/** The contractor's most recent successful live payout outside this run. Simulated never counts. */
export async function lastPaidForContractor(
  db: Db,
  orgId: string,
  contractorId: string,
  excludingRunId: string,
) {
  const [row] = await db
    .select({ destinationId: payRunItems.destinationId, amount: payRunItems.amountUsdc })
    .from(payoutAttempts)
    .innerJoin(payRunItems, eq(payRunItems.id, payoutAttempts.lineItemId))
    .where(
      and(
        eq(payoutAttempts.orgId, orgId),
        eq(payRunItems.contractorId, contractorId),
        ne(payRunItems.payRunId, excludingRunId),
        eq(payoutAttempts.status, "SUCCESS"),
        eq(payoutAttempts.mode, "live"),
      ),
    )
    .orderBy(desc(payoutAttempts.createdAt))
    .limit(1);
  return row && row.destinationId
    ? { destinationId: row.destinationId, amount: row.amount }
    : undefined;
}

// --- Signing and settlement ---

type AttemptStatus = (typeof schema.attemptStatusEnum.enumValues)[number];

/** Live attempts in these statuses, across orgs, for the worker: each with its run and route mode. */
export async function listAttemptsByStatus(db: Db, statuses: readonly AttemptStatus[]) {
  const rows = await db
    .select({
      attempt: payoutAttempts,
      payRunId: payRunItems.payRunId,
      destinationId: payRunItems.destinationId,
      payoutMode: payoutDestinations.payoutMode,
    })
    .from(payoutAttempts)
    .innerJoin(payRunItems, eq(payRunItems.id, payoutAttempts.lineItemId))
    .leftJoin(payoutDestinations, eq(payoutDestinations.id, payRunItems.destinationId))
    .where(inArray(payoutAttempts.status, [...statuses]));
  return rows.map((r) => ({
    ...r.attempt,
    payRunId: r.payRunId,
    destinationId: r.destinationId,
    payoutMode: r.payoutMode,
  }));
}

/** Changes an attempt only if it's still in the status read. Returns false if it moved meanwhile. */
export async function moveAttempt(
  db: Db,
  orgId: string,
  attemptId: string,
  from: AttemptStatus,
  values: Partial<typeof payoutAttempts.$inferInsert>,
) {
  const rows = await db
    .update(payoutAttempts)
    .set(values)
    .where(
      and(
        eq(payoutAttempts.orgId, orgId),
        eq(payoutAttempts.id, attemptId),
        eq(payoutAttempts.status, from),
      ),
    )
    .returning({ id: payoutAttempts.id });
  return rows.length === 1;
}

/** QUOTED → SIGNED. The single winner here is the only caller that submits. */
export function claimAttemptForSigning(
  db: Db,
  orgId: string,
  attemptId: string,
  values: Partial<typeof payoutAttempts.$inferInsert>,
) {
  return moveAttempt(db, orgId, attemptId, "QUOTED", { ...values, status: "SIGNED" });
}

export async function insertSignRequest(db: Db, values: typeof signRequests.$inferInsert) {
  const [row] = await db.insert(signRequests).values(values).returning();
  if (!row) throw new Error("sign request was not created");
  return row;
}

export async function getSignRequest(db: Db, orgId: string, requestId: string) {
  const [row] = await db
    .select()
    .from(signRequests)
    .where(and(eq(signRequests.orgId, orgId), eq(signRequests.id, requestId)));
  return row;
}

export async function consumeSignRequest(db: Db, orgId: string, requestId: string, now: Date) {
  const rows = await db
    .update(signRequests)
    .set({ usedAt: now })
    .where(
      and(
        eq(signRequests.orgId, orgId),
        eq(signRequests.id, requestId),
        isNull(signRequests.usedAt),
        gt(signRequests.expiresAt, now),
      ),
    )
    .returning({ id: signRequests.id });
  return rows.length === 1;
}

export async function insertEncumbrance(
  db: Db,
  values: { orgId: string; attemptId: string; amount: bigint; until: Date },
) {
  await db.insert(encumbrances).values(values);
}

export async function releaseEncumbrance(
  db: Db,
  orgId: string,
  attemptId: string,
  reason: string,
  now: Date,
) {
  await db
    .update(encumbrances)
    .set({ releasedAt: now, reason })
    .where(
      and(
        eq(encumbrances.orgId, orgId),
        eq(encumbrances.attemptId, attemptId),
        isNull(encumbrances.releasedAt),
      ),
    );
}

/** Funds the treasury can't count on: every encumbrance not yet released. */
export async function activeEncumbranceTotal(db: Db, orgId: string): Promise<bigint> {
  const [row] = await db
    .select({ total: sum(encumbrances.amount) })
    .from(encumbrances)
    .where(and(eq(encumbrances.orgId, orgId), isNull(encumbrances.releasedAt)));
  return BigInt(row?.total ?? "0");
}

/** Active encumbrances past their deadline, or on a settled attempt, for the release job. */
export async function listDueEncumbrances(db: Db, now: Date) {
  return db
    .select({
      orgId: encumbrances.orgId,
      attemptId: encumbrances.attemptId,
      attemptStatus: payoutAttempts.status,
      failureReason: payoutAttempts.failureReason,
    })
    .from(encumbrances)
    .innerJoin(payoutAttempts, eq(payoutAttempts.id, encumbrances.attemptId))
    .where(
      and(
        isNull(encumbrances.releasedAt),
        or(lte(encumbrances.until, now), eq(payoutAttempts.status, "SUCCESS")),
      ),
    );
}

/** Stored signed payloads that can do nothing more: settled, or past their message deadline. */
export async function listPayloadsToDelete(db: Db, now: Date) {
  return db
    .select({ id: payoutAttempts.id, orgId: payoutAttempts.orgId, status: payoutAttempts.status })
    .from(payoutAttempts)
    .where(
      and(
        isNotNull(payoutAttempts.encryptedSignedPayload),
        inArray(payoutAttempts.status, ["SUCCESS", "REFUNDED", "FAILED", "EXPIRED"]),
        or(eq(payoutAttempts.status, "SUCCESS"), lte(payoutAttempts.signedMessageDeadline, now)),
      ),
    );
}

export async function markDestinationPubliclyPaid(db: Db, orgId: string, destinationId: string) {
  await db
    .update(payoutDestinations)
    .set({ receivedPublicPayout: true })
    .where(and(eq(payoutDestinations.orgId, orgId), eq(payoutDestinations.id, destinationId)));
}

// --- Reporting (slice 6). Read-only. ---

/** Every payout attempt of an org, with what a ledger row needs. Simulated rows included: callers filter. */
export async function ledgerAttempts(db: Db, orgId: string) {
  const rows = await db
    .select({
      attempt: payoutAttempts,
      payRunId: payRunItems.payRunId,
      amountUsdc: payRunItems.amountUsdc,
      contractorId: payRunItems.contractorId,
      period: payRuns.period,
      contractorName: contractors.name,
      route: payoutDestinations.route,
      recipient: payoutDestinations.address,
    })
    .from(payoutAttempts)
    .innerJoin(payRunItems, eq(payRunItems.id, payoutAttempts.lineItemId))
    .innerJoin(payRuns, eq(payRuns.id, payRunItems.payRunId))
    .innerJoin(contractors, eq(contractors.id, payRunItems.contractorId))
    .leftJoin(payoutDestinations, eq(payoutDestinations.id, payRunItems.destinationId))
    .where(eq(payoutAttempts.orgId, orgId));
  return rows.map((r) => ({
    ...r.attempt,
    payRunId: r.payRunId,
    amountUsdc: r.amountUsdc,
    contractorId: r.contractorId,
    period: r.period,
    contractorName: r.contractorName,
    route: r.route,
    recipient: r.recipient,
  }));
}

export async function ledgerTreasuryEvents(db: Db, orgId: string) {
  return db.select().from(treasuryEvents).where(eq(treasuryEvents.orgId, orgId));
}

/**
 * Keyset (cursor) pagination, done in the database (L37). Rows run newest first on (at, id); "at"
 * is compared as whole microseconds since the epoch, Postgres's own precision, so a cursor never
 * loses the sub-millisecond part a JavaScript Date would drop. The id breaks ties on timestamp.
 */
export type Keyset = { afterUs?: bigint; afterId?: string; limit: number };
const epochUs = (t: SQL | AnyColumn) => sql<string>`(extract(epoch from ${t}) * 1000000)::bigint`;
function keysetWhere(at: SQL | AnyColumn, id: AnyColumn, k: Keyset): SQL | undefined {
  if (k.afterUs === undefined || k.afterId === undefined) return undefined;
  return sql`(${epochUs(at)}, ${id}) < (${k.afterUs.toString()}::bigint, ${k.afterId}::uuid)`;
}

export type LedgerFilter = {
  mode?: "live" | "simulated";
  period?: string;
  contractorId?: string;
  status?: string;
};
const attemptAt = sql`coalesce(${schema.payoutAttempts.terminalAt}, ${schema.payoutAttempts.createdAt})`;

/** One page of payout attempts, filters and order in SQL. Returns at most k.limit rows. */
export async function ledgerAttemptsPage(db: Db, orgId: string, f: LedgerFilter, k: Keyset) {
  const rows = await db
    .select({
      attempt: payoutAttempts,
      atUs: sql<string>`${epochUs(attemptAt)}::text`,
      payRunId: payRunItems.payRunId,
      amountUsdc: payRunItems.amountUsdc,
      contractorId: payRunItems.contractorId,
      period: payRuns.period,
      contractorName: contractors.name,
      route: payoutDestinations.route,
      recipient: payoutDestinations.address,
    })
    .from(payoutAttempts)
    .innerJoin(payRunItems, eq(payRunItems.id, payoutAttempts.lineItemId))
    .innerJoin(payRuns, eq(payRuns.id, payRunItems.payRunId))
    .innerJoin(contractors, eq(contractors.id, payRunItems.contractorId))
    .leftJoin(payoutDestinations, eq(payoutDestinations.id, payRunItems.destinationId))
    .where(
      and(
        eq(payoutAttempts.orgId, orgId),
        f.mode ? eq(payoutAttempts.mode, f.mode) : undefined,
        f.period ? eq(payRuns.period, f.period) : undefined,
        f.contractorId ? eq(payRunItems.contractorId, f.contractorId) : undefined,
        f.status ? eq(payoutAttempts.status, f.status as never) : undefined,
        keysetWhere(attemptAt, payoutAttempts.id, k),
      ),
    )
    .orderBy(desc(epochUs(attemptAt)), desc(payoutAttempts.id))
    .limit(k.limit);
  return rows.map((r) => ({
    ...r.attempt,
    atUs: BigInt(r.atUs),
    payRunId: r.payRunId,
    amountUsdc: r.amountUsdc,
    contractorId: r.contractorId,
    period: r.period,
    contractorName: r.contractorName,
    route: r.route,
    recipient: r.recipient,
  }));
}

/** One page of treasury events (funding, shield), filters and order in SQL. */
export async function ledgerTreasuryEventsPage(
  db: Db,
  orgId: string,
  f: Omit<LedgerFilter, "contractorId">,
  k: Keyset,
) {
  const at = treasuryEvents.createdAt;
  const rows = await db
    .select({ event: treasuryEvents, atUs: sql<string>`${epochUs(at)}::text` })
    .from(treasuryEvents)
    .where(
      and(
        eq(treasuryEvents.orgId, orgId),
        f.mode ? eq(treasuryEvents.mode, f.mode) : undefined,
        f.period ? sql`to_char(${at} at time zone 'UTC', 'YYYY-MM') = ${f.period}` : undefined,
        f.status ? eq(treasuryEvents.status, f.status) : undefined,
        keysetWhere(at, treasuryEvents.id, k),
      ),
    )
    .orderBy(desc(epochUs(at)), desc(treasuryEvents.id))
    .limit(k.limit);
  return rows.map((r) => ({ ...r.event, atUs: BigInt(r.atUs) }));
}

/** An exact action, or a prefix ending in "*". Keyset-paginated in SQL, newest first. */
export async function listAuditPage(db: Db, orgId: string, action: string | undefined, k: Keyset) {
  const filter = action
    ? action.endsWith("*")
      ? like(auditLog.action, `${action.slice(0, -1).replaceAll("%", "").replaceAll("_", "\\_")}%`)
      : eq(auditLog.action, action)
    : undefined;
  const rows = await db
    .select({ entry: auditLog, atUs: sql<string>`${epochUs(auditLog.at)}::text` })
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), filter, keysetWhere(auditLog.at, auditLog.id, k)))
    .orderBy(desc(epochUs(auditLog.at)), desc(auditLog.id))
    .limit(k.limit);
  return rows.map((r) => ({ ...r.entry, atUs: BigInt(r.atUs) }));
}

/** For the evidence generator, which spans every org. */
export async function listOrgIds(db: Db) {
  return (await db.select({ id: organizations.id }).from(organizations)).map((o) => o.id);
}

/** orgId is null only for events with no organization: sign-in and logout. */
export async function writeAudit(
  db: Db,
  values: {
    orgId: string | null;
    actor: string;
    action: string;
    entity: string;
    entityId: string;
    at: Date;
  },
) {
  await db.insert(auditLog).values(values);
}
