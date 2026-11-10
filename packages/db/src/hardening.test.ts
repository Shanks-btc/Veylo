import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { createTestDb, seedLineItem, type TestDb } from "./test-db.js";

const {
  contractors,
  memberships,
  payeeApprovals,
  payeeRegistryHeads,
  payoutAttempts,
  payoutDestinations,
  payRunItems,
  payRuns,
  users,
} = schema;

let db: TestDb;
let close: () => Promise<void>;
beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  close = () => created.client.close();
});
afterEach(() => close());

async function rejection(run: () => PromiseLike<unknown>) {
  try {
    await run();
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string; message?: string } })
      .cause;
    return { code: cause?.code, constraint: cause?.constraint, message: cause?.message ?? "" };
  }
  throw new Error("expected the database to reject this");
}

const T = new Date("2026-11-06T10:00:00.000Z");

describe("payee_registry_heads version sequence", () => {
  const head = (orgId: string, version: number) => ({
    orgId,
    version,
    activeSetHash: "hash",
    payload: {},
    ownerPublicKey: "ed25519:key",
    signature: "sig",
    signedAt: T,
  });

  it("the first version must be 1", async () => {
    const { orgId } = await seedLineItem(db);
    const err = await rejection(() => db.insert(payeeRegistryHeads).values(head(orgId, 2)));
    expect(err.message).toContain("must be 1");
    await expect(db.insert(payeeRegistryHeads).values(head(orgId, 1))).resolves.toBeDefined();
  });

  it("accepts max + 1 and rejects gaps, repeats and rollbacks", async () => {
    const { orgId } = await seedLineItem(db);
    await db.insert(payeeRegistryHeads).values(head(orgId, 1));
    await db.insert(payeeRegistryHeads).values(head(orgId, 2));
    for (const bad of [1, 2, 4, 0, -1]) {
      const err = await rejection(() => db.insert(payeeRegistryHeads).values(head(orgId, bad)));
      expect(err.message).toContain("must be 3");
    }
    await expect(db.insert(payeeRegistryHeads).values(head(orgId, 3))).resolves.toBeDefined();
  });

  describe("append-only", () => {
    const seeded = async () => {
      const { orgId } = await seedLineItem(db);
      await db.insert(payeeRegistryHeads).values(head(orgId, 1));
    };

    it("rejects UPDATE", async () => {
      await seeded();
      const err = await rejection(() => db.update(payeeRegistryHeads).set({ signature: "forged" }));
      expect(err.message).toContain("append-only");
      const [row] = await db.select().from(payeeRegistryHeads);
      expect(row?.signature).toBe("sig");
    });

    it("rejects DELETE", async () => {
      await seeded();
      const err = await rejection(() => db.delete(payeeRegistryHeads));
      expect(err.message).toContain("append-only");
      expect(await db.select().from(payeeRegistryHeads)).toHaveLength(1);
    });

    it("rejects TRUNCATE", async () => {
      await seeded();
      const err = await rejection(() => db.execute(sql`TRUNCATE payee_registry_heads`));
      expect(err.message).toContain("append-only");
      expect(await db.select().from(payeeRegistryHeads)).toHaveLength(1);
    });
  });

  it("counts per org", async () => {
    const a = await seedLineItem(db);
    const b = await seedLineItem(db);
    await db.insert(payeeRegistryHeads).values(head(a.orgId, 1));
    await db.insert(payeeRegistryHeads).values(head(a.orgId, 2));
    await expect(db.insert(payeeRegistryHeads).values(head(b.orgId, 1))).resolves.toBeDefined();
  });
});

describe("payee_approvals are immutable", () => {
  async function approval() {
    const { orgId, destinationId } = await seedLineItem(db);
    await db.insert(payeeApprovals).values({
      orgId,
      destinationId,
      version: 1,
      payload: { a: 1 },
      message: "m",
      contractorName: "c",
      ownerAccountId: "owner.near",
      ownerPublicKey: "ed25519:key",
      signature: "sig",
      approvedAt: T,
      expiresAt: T,
    });
  }

  it("allows setting revoked_at from NULL, once", async () => {
    await approval();
    await db.update(payeeApprovals).set({ revokedAt: T });
    const [row] = await db.select().from(payeeApprovals);
    expect(row?.revokedAt).toEqual(T);
    const err = await rejection(() =>
      db.update(payeeApprovals).set({ revokedAt: new Date("2027-01-01T00:00:00.000Z") }),
    );
    expect(err.message).toContain("immutable");
  });

  it("rejects clearing revoked_at", async () => {
    await approval();
    await db.update(payeeApprovals).set({ revokedAt: T });
    const err = await rejection(() => db.update(payeeApprovals).set({ revokedAt: null }));
    expect(err.message).toContain("immutable");
  });

  it.each([
    ["signature", { signature: "forged" }],
    ["payload", { payload: { a: 2 } }],
    ["owner_public_key", { ownerPublicKey: "ed25519:other" }],
    ["owner_account_id", { ownerAccountId: "other.near" }],
    ["version", { version: 2 }],
    ["message", { message: "forged" }],
    ["contractor_name", { contractorName: "forged" }],
    ["expires_at", { expiresAt: new Date("2030-01-01T00:00:00.000Z") }],
    ["approved_at", { approvedAt: new Date("2030-01-01T00:00:00.000Z") }],
  ])("rejects changing %s", async (_name, change) => {
    await approval();
    const err = await rejection(() => db.update(payeeApprovals).set(change));
    expect(err.message).toContain("immutable");
  });

  it("rejects changing a field while revoking", async () => {
    await approval();
    const err = await rejection(() =>
      db.update(payeeApprovals).set({ revokedAt: T, signature: "forged" }),
    );
    expect(err.message).toContain("immutable");
  });

  it("rejects DELETE", async () => {
    await approval();
    const err = await rejection(() => db.delete(payeeApprovals));
    expect(err.message).toContain("immutable");
    expect(await db.select().from(payeeApprovals)).toHaveLength(1);
  });
});

describe("payee_approvals TRUNCATE", () => {
  it("is rejected", async () => {
    const err = await rejection(() => db.execute(sql`TRUNCATE payee_approvals CASCADE`));
    expect(err.message).toContain("immutable");
  });
});

describe("cross-org references are rejected", () => {
  async function twoOrgs() {
    return { a: await seedLineItem(db), b: await seedLineItem(db) };
  }
  const FK = "23503";

  it("payout_destinations -> contractors", async () => {
    const { a, b } = await twoOrgs();
    const err = await rejection(() =>
      db.insert(payoutDestinations).values({
        orgId: a.orgId,
        contractorId: b.contractorId,
        route: "usdc-base",
        payoutMode: "direct",
        chain: "base",
        assetId: "x",
        address: "0x2",
      }),
    );
    expect(err).toMatchObject({ code: FK, constraint: "payout_destinations_contractor_same_org" });
  });

  it("payee_approvals -> payout_destinations", async () => {
    const { a, b } = await twoOrgs();
    const err = await rejection(() =>
      db.insert(payeeApprovals).values({
        orgId: a.orgId,
        destinationId: b.destinationId,
        version: 1,
        payload: {},
        message: "m",
        contractorName: "c",
        ownerAccountId: "o",
        ownerPublicKey: "k",
        signature: "s",
        approvedAt: T,
        expiresAt: T,
      }),
    );
    expect(err).toMatchObject({ code: FK, constraint: "payee_approvals_destination_same_org" });
  });

  /** A run with no items, so the one-item-per-contractor rule isn't what rejects the insert. */
  const emptyRun = async (orgId: string) => {
    const [run] = await db
      .insert(schema.payRuns)
      .values({
        orgId,
        period: "2026-11",
        status: "Draft",
        preparedBy: "user",
        totalAmountUsdc: 0n,
        mode: "simulated",
      })
      .returning();
    return (run as { id: string }).id;
  };

  const item = (
    a: { orgId: string; payRunId: string; contractorId: string; destinationId: string },
    change: object,
  ) => ({
    orgId: a.orgId,
    payRunId: a.payRunId,
    contractorId: a.contractorId,
    destinationId: a.destinationId,
    amountUsdc: 1n,
    basis: {},
    mode: "simulated" as const,
    ...change,
  });

  it("pay_run_items -> pay_runs", async () => {
    const { a, b } = await twoOrgs();
    const err = await rejection(() =>
      db.insert(payRunItems).values(item(a, { payRunId: b.payRunId })),
    );
    expect(err).toMatchObject({ code: FK, constraint: "pay_run_items_pay_run_same_org" });
  });

  it("pay_run_items -> contractors", async () => {
    const { a, b } = await twoOrgs();
    const err = await rejection(() =>
      db.insert(payRunItems).values(item(a, { contractorId: b.contractorId })),
    );
    expect(err).toMatchObject({ code: FK, constraint: "pay_run_items_contractor_same_org" });
  });

  it("pay_run_items -> payout_destinations", async () => {
    const { a, b } = await twoOrgs();
    const payRunId = await emptyRun(a.orgId);
    const err = await rejection(() =>
      db.insert(payRunItems).values(item(a, { destinationId: b.destinationId, payRunId })),
    );
    expect(err).toMatchObject({ code: FK, constraint: "pay_run_items_destination_same_org" });
  });

  it("payout_attempts -> pay_run_items", async () => {
    const { a, b } = await twoOrgs();
    const err = await rejection(() =>
      db.insert(payoutAttempts).values({
        orgId: a.orgId,
        lineItemId: b.itemId,
        attemptNo: 1,
        status: "PLANNED",
        mode: "simulated",
      }),
    );
    expect(err).toMatchObject({ code: FK, constraint: "payout_attempts_line_item_same_org" });
  });

  it("moving a child to another org is rejected too", async () => {
    const { a, b } = await twoOrgs();
    const err = await rejection(() =>
      db.update(contractors).set({ orgId: b.orgId }).where(eq(contractors.id, a.contractorId)),
    );
    expect(err.code).toBe(FK);
  });
});

describe("pay_runs.approved_by must be a member of the org", () => {
  async function setup() {
    const a = await seedLineItem(db);
    const b = await seedLineItem(db);
    const [user] = await db.insert(users).values({ nearAccountId: "approver.near" }).returning();
    if (!user) throw new Error("no user");
    const approve = (orgId: string) => () =>
      db.update(payRuns).set({ approvedBy: user.id }).where(eq(payRuns.orgId, orgId));
    return { a, b, user, approve };
  }
  const member = (orgId: string, userId: string) =>
    db.insert(memberships).values({ orgId, userId, role: "owner" });

  it("rejects a user with no membership", async () => {
    const { a, approve } = await setup();
    const err = await rejection(approve(a.orgId));
    expect(err).toMatchObject({ code: "23503", constraint: "pay_runs_approver_is_member" });
  });

  it("rejects a member of another org only", async () => {
    const { a, b, user, approve } = await setup();
    await member(b.orgId, user.id);
    const err = await rejection(approve(a.orgId));
    expect(err).toMatchObject({ code: "23503", constraint: "pay_runs_approver_is_member" });
  });

  it("accepts a member of the org", async () => {
    const { a, user, approve } = await setup();
    await member(a.orgId, user.id);
    await approve(a.orgId)();
    const [run] = await db.select().from(payRuns).where(eq(payRuns.orgId, a.orgId));
    expect(run?.approvedBy).toBe(user.id);
  });

  it("allows no approver yet", async () => {
    const { a } = await setup();
    const [run] = await db.select().from(payRuns).where(eq(payRuns.orgId, a.orgId));
    expect(run?.approvedBy).toBeNull();
  });

  it("rejects removing the membership of a recorded approver", async () => {
    const { a, user, approve } = await setup();
    await member(a.orgId, user.id);
    await approve(a.orgId)();
    // The no-delete trigger would reject this first, so switch it off to reach the foreign key.
    await db.execute(sql`ALTER TABLE memberships DISABLE TRIGGER USER`);
    const err = await rejection(() => db.delete(memberships));
    expect(err).toMatchObject({ code: "23503", constraint: "pay_runs_approver_is_member" });
  });
});

describe("pay_runs.approved_by must be an active owner at approval", () => {
  async function setup(role: "owner" | "viewer" | "accountant") {
    const { orgId, payRunId } = await seedLineItem(db);
    const [user] = await db.insert(users).values({ nearAccountId: "approver.near" }).returning();
    if (!user) throw new Error("no user");
    await db.insert(memberships).values({ orgId, userId: user.id, role });
    return { orgId, payRunId, userId: user.id };
  }
  const approve = (payRunId: string, userId: string) =>
    db.update(payRuns).set({ approvedBy: userId }).where(eq(payRuns.id, payRunId));
  const removeMember = (orgId: string, userId: string) =>
    db
      .update(memberships)
      .set({ status: "removed", removedAt: T })
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  const REASON = "must be an active owner";

  it("accepts an active owner", async () => {
    const { payRunId, userId } = await setup("owner");
    await approve(payRunId, userId);
    const [run] = await db.select().from(payRuns).where(eq(payRuns.id, payRunId));
    expect(run?.approvedBy).toBe(userId);
  });

  it.each(["viewer", "accountant"] as const)("rejects a %s", async (role) => {
    const { payRunId, userId } = await setup(role);
    const err = await rejection(() => approve(payRunId, userId));
    expect(err.code).toBe("23514");
    expect(err.message).toContain(REASON);
  });

  it("rejects a removed owner", async () => {
    const { orgId, payRunId, userId } = await setup("owner");
    await removeMember(orgId, userId);
    const err = await rejection(() => approve(payRunId, userId));
    expect(err.message).toContain(REASON);
  });

  it("rejects an ineligible approver on INSERT", async () => {
    const { orgId, userId } = await setup("viewer");
    const err = await rejection(() =>
      db.insert(payRuns).values({
        orgId,
        period: "2026-12",
        status: "Quoting",
        preparedBy: "user",
        totalAmountUsdc: 1n,
        mode: "simulated",
        approvedBy: userId,
      }),
    );
    expect(err.message).toContain(REASON);
  });

  it("rejects swapping a recorded approver for an ineligible one", async () => {
    const { orgId, payRunId, userId } = await setup("owner");
    await approve(payRunId, userId);
    const [viewer] = await db.insert(users).values({ nearAccountId: "viewer.near" }).returning();
    await db.insert(memberships).values({ orgId, userId: viewer!.id, role: "viewer" });
    const err = await rejection(() => approve(payRunId, viewer!.id));
    expect(err.message).toContain(REASON);
  });

  it("removing an approver later keeps the recorded approval editable", async () => {
    const { orgId, payRunId, userId } = await setup("owner");
    await approve(payRunId, userId);
    await removeMember(orgId, userId);
    await db.update(payRuns).set({ status: "Signing" }).where(eq(payRuns.id, payRunId));
    const [run] = await db.select().from(payRuns).where(eq(payRuns.id, payRunId));
    expect(run).toMatchObject({ approvedBy: userId, status: "Signing" });
  });
});

describe("failure_reason", () => {
  const row = (orgId: string, lineItemId: string, extra: object) => ({
    orgId,
    lineItemId,
    attemptNo: 1,
    mode: "simulated" as const,
    ...extra,
  });

  it("rejects FAILED without a reason", async () => {
    const { orgId, itemId } = await seedLineItem(db);
    const err = await rejection(() =>
      db.insert(payoutAttempts).values(row(orgId, itemId, { status: "FAILED" }) as never),
    );
    expect(err.constraint).toBe("payout_attempts_failure_reason_iff_failed");
  });

  it("rejects a reason on any other status", async () => {
    const { orgId, itemId } = await seedLineItem(db);
    const err = await rejection(() =>
      db
        .insert(payoutAttempts)
        .values(row(orgId, itemId, { status: "EXPIRED", failureReason: "unknown" }) as never),
    );
    expect(err.constraint).toBe("payout_attempts_failure_reason_iff_failed");
  });

  it("accepts FAILED with a reason, and rejects an unlisted reason", async () => {
    const { orgId, itemId } = await seedLineItem(db);
    await db
      .insert(payoutAttempts)
      .values(row(orgId, itemId, { status: "FAILED", failureReason: "quote_rejected" }) as never);
    const err = await rejection(() =>
      db.execute(
        sql`INSERT INTO payout_attempts (org_id, line_item_id, attempt_no, status, failure_reason, mode) VALUES (${orgId}, ${itemId}, 2, 'FAILED', 'made_up', 'simulated')`,
      ),
    );
    expect(err.code).toBe("22P02");
  });
});
