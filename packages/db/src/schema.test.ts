import {
  ATTEMPT_STATUSES,
  isTerminal,
  MODES,
  PAY_RUN_STATUSES,
  type AttemptStatus,
} from "@veylo/core";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { createTestDb, seedLineItem, type TestDb } from "./test-db.js";

const { auditLog, organizations, payeeRegistryHeads, payoutAttempts } = schema;

// Each test gets a brand-new database with freshly applied migrations.
let db: TestDb;
let close: () => Promise<void>;
beforeEach(async () => {
  const created = await createTestDb();
  db = created.db;
  close = () => created.client.close();
});
afterEach(() => close());

/** The driver's error carries the Postgres code and constraint name on its cause. */
async function rejection(
  run: () => PromiseLike<unknown>,
): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await run();
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string; message?: string } })
      .cause;
    return {
      code: cause?.code,
      constraint: cause?.constraint,
      message: `${cause?.message ?? ""} ${(err as Error).message}`,
    };
  }
  throw new Error("expected the database to reject this");
}

const attempt = (
  orgId: string,
  lineItemId: string,
  overrides: Partial<typeof payoutAttempts.$inferInsert> = {},
): typeof payoutAttempts.$inferInsert => ({
  orgId,
  lineItemId,
  attemptNo: 1,
  status: "PLANNED",
  mode: "simulated",
  ...(overrides.status === "FAILED" ? { failureReason: "unknown" as const } : {}),
  ...overrides,
});

describe("UNIQUE(deposit_address)", () => {
  it("rejects a duplicate deposit address, even on another line item", async () => {
    const { orgId, itemId, addItem } = await seedLineItem(db);
    const other = await addItem();
    await db
      .insert(payoutAttempts)
      .values(attempt(orgId, itemId, { depositAddress: "dep-1", status: "QUOTED" }));
    const err = await rejection(() =>
      db
        .insert(payoutAttempts)
        .values(attempt(orgId, other, { depositAddress: "dep-1", status: "QUOTED" })),
    );
    expect(err.code).toBe("23505");
    expect(err.constraint).toBe("payout_attempts_deposit_address_unique");
  });

  it("allows many attempts with no deposit address yet", async () => {
    const { orgId, itemId, addItem } = await seedLineItem(db);
    const other = await addItem();
    await db.insert(payoutAttempts).values(attempt(orgId, itemId));
    await expect(db.insert(payoutAttempts).values(attempt(orgId, other))).resolves.toBeDefined();
  });
});

describe("UNIQUE(line_item_id, attempt_no)", () => {
  it("rejects a duplicate attempt number", async () => {
    const { orgId, itemId } = await seedLineItem(db);
    await db.insert(payoutAttempts).values(attempt(orgId, itemId, { status: "FAILED" }));
    const err = await rejection(() =>
      db.insert(payoutAttempts).values(attempt(orgId, itemId, { status: "FAILED" })),
    );
    expect(err.code).toBe("23505");
    expect(err.constraint).toBe("payout_attempts_line_item_attempt_unique");
  });

  it("allows the same attempt number on another line item", async () => {
    const { orgId, itemId, addItem } = await seedLineItem(db);
    await db.insert(payoutAttempts).values(attempt(orgId, itemId));
    await expect(
      db.insert(payoutAttempts).values(attempt(orgId, await addItem())),
    ).resolves.toBeDefined();
  });
});

describe("at most one non-terminal attempt per line item", () => {
  const nonTerminal = ATTEMPT_STATUSES.filter((s) => !isTerminal(s));
  const terminal = ATTEMPT_STATUSES.filter((s) => isTerminal(s));

  it.each(nonTerminal)(
    "rejects a second non-terminal attempt beside %s",
    async (status: AttemptStatus) => {
      const { orgId, itemId } = await seedLineItem(db);
      await db.insert(payoutAttempts).values(attempt(orgId, itemId, { status }));
      const err = await rejection(() =>
        db
          .insert(payoutAttempts)
          .values(attempt(orgId, itemId, { attemptNo: 2, status: "PLANNED" })),
      );
      expect(err.code).toBe("23505");
      expect(err.constraint).toBe("payout_attempts_one_non_terminal_per_item");
    },
  );

  it.each(terminal)("allows a new attempt after %s", async (status: AttemptStatus) => {
    const { orgId, itemId } = await seedLineItem(db);
    await db.insert(payoutAttempts).values(attempt(orgId, itemId, { status }));
    await expect(
      db.insert(payoutAttempts).values(attempt(orgId, itemId, { attemptNo: 2 })),
    ).resolves.toBeDefined();
  });

  it("rejects an update that would make two attempts non-terminal", async () => {
    const { orgId, itemId } = await seedLineItem(db);
    await db.insert(payoutAttempts).values(attempt(orgId, itemId, { status: "EXPIRED" }));
    await db.insert(payoutAttempts).values(attempt(orgId, itemId, { attemptNo: 2 }));
    const err = await rejection(() =>
      db.update(payoutAttempts).set({ status: "SIGNED" }).where(eq(payoutAttempts.attemptNo, 1)),
    );
    expect(err.constraint).toBe("payout_attempts_one_non_terminal_per_item");
  });

  it("allows a new attempt once the previous one becomes terminal", async () => {
    const { orgId, itemId } = await seedLineItem(db);
    await db.insert(payoutAttempts).values(attempt(orgId, itemId));
    await db
      .update(payoutAttempts)
      .set({ status: "EXPIRED" })
      .where(eq(payoutAttempts.attemptNo, 1));
    await expect(
      db.insert(payoutAttempts).values(attempt(orgId, itemId, { attemptNo: 2 })),
    ).resolves.toBeDefined();
  });

  it("allows one non-terminal attempt on each of two line items", async () => {
    const { orgId, itemId, addItem } = await seedLineItem(db);
    await db.insert(payoutAttempts).values(attempt(orgId, itemId));
    await expect(
      db.insert(payoutAttempts).values(attempt(orgId, await addItem())),
    ).resolves.toBeDefined();
  });
});

describe("UNIQUE(payee_registry_heads.org_id, version)", () => {
  const head = (orgId: string, version: number) => ({
    orgId,
    version,
    activeSetHash: "hash",
    payload: {},
    ownerPublicKey: "ed25519:key",
    signature: "sig",
    signedAt: new Date("2026-11-06T10:00:00.000Z"),
  });

  it("rejects a duplicate version in the same org", async () => {
    const { orgId } = await seedLineItem(db);
    await db.insert(payeeRegistryHeads).values(head(orgId, 1));
    // The sequence trigger would reject this first, so switch it off to reach the constraint itself.
    await db.execute(sql`ALTER TABLE payee_registry_heads DISABLE TRIGGER USER`);
    const err = await rejection(() => db.insert(payeeRegistryHeads).values(head(orgId, 1)));
    expect(err.code).toBe("23505");
    expect(err.constraint).toBe("payee_registry_heads_org_version_unique");
  });

  it("allows the same version in another org, and a higher one in the same org", async () => {
    const { orgId } = await seedLineItem(db);
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    await db.insert(payeeRegistryHeads).values(head(orgId, 1));
    await expect(db.insert(payeeRegistryHeads).values(head(other!.id, 1))).resolves.toBeDefined();
    await expect(db.insert(payeeRegistryHeads).values(head(orgId, 2))).resolves.toBeDefined();
  });
});

describe("audit_log is append-only", () => {
  const entry = (orgId: string) => ({
    orgId,
    actor: "user",
    action: "test",
    entity: "pay_run",
    entityId: "1",
  });

  it("allows inserts and reads", async () => {
    const { orgId } = await seedLineItem(db);
    await db.insert(auditLog).values(entry(orgId));
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it("blocks UPDATE and keeps the row", async () => {
    const { orgId } = await seedLineItem(db);
    await db.insert(auditLog).values(entry(orgId));
    const err = await rejection(() => db.update(auditLog).set({ action: "changed" }));
    expect(err.message).toContain("audit_log is append-only");
    const [row] = await db.select().from(auditLog);
    expect(row?.action).toBe("test");
  });

  it("blocks DELETE and keeps the row", async () => {
    const { orgId } = await seedLineItem(db);
    await db.insert(auditLog).values(entry(orgId));
    const err = await rejection(() => db.delete(auditLog));
    expect(err.message).toContain("audit_log is append-only");
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it("blocks TRUNCATE and keeps the row", async () => {
    const { orgId } = await seedLineItem(db);
    await db.insert(auditLog).values(entry(orgId));
    const err = await rejection(() => db.execute(sql`TRUNCATE audit_log`));
    expect(err.message).toContain("audit_log is append-only");
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });
});

describe("money columns", () => {
  it("round-trips values too large for a float, exactly", async () => {
    const { orgId, itemId } = await seedLineItem(db);
    const large = 9007199254740993n; // Number(large) would become ...992
    await db
      .insert(payoutAttempts)
      .values(
        attempt(orgId, itemId, { minAmountIn: large, amountIn: large + 1n, refundedAmount: 1n }),
      );
    const [row] = await db.select().from(payoutAttempts);
    expect(row?.minAmountIn).toBe(large);
    expect(row?.amountIn).toBe(large + 1n);
    expect(typeof row?.amountIn).toBe("bigint");
  });

  it("are bigint today, with no float column, and any numeric must be numeric(78,0)", async () => {
    const columns = await db.execute<{
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      sql`SELECT table_name, column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const types = Object.fromEntries(columns.rows.map((c) => [c.column_name, c.data_type]));
    for (const name of [
      "min_amount_in",
      "amount_in",
      "refunded_amount",
      "amount_usdc",
      "total_amount_usdc",
    ]) {
      expect(types[name]).toBe("bigint");
    }
    const inexact = columns.rows.filter(
      (c) =>
        /real|double|money|decimal/i.test(c.data_type) ||
        (c.data_type === "numeric" && (c.numeric_precision !== 78 || c.numeric_scale !== 0)),
    );
    expect(inexact).toEqual([]);
  });

  it("reject negative amounts", async () => {
    const { orgId, itemId } = await seedLineItem(db);
    const err = await rejection(() =>
      db.insert(payoutAttempts).values(attempt(orgId, itemId, { amountIn: -1n })),
    );
    expect(err.constraint).toBe("payout_attempts_amounts_non_negative");
  });
});

describe("mode and tenancy", () => {
  async function columnsOf(table: string) {
    const result = await db.execute<{ column_name: string; is_nullable: string }>(
      sql`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`,
    );
    return Object.fromEntries(result.rows.map((c) => [c.column_name, c.is_nullable]));
  }

  it.each(["pay_runs", "pay_run_items", "payout_attempts"])(
    "%s has a required mode",
    async (table) => {
      expect((await columnsOf(table)).mode).toBe("NO");
    },
  );

  it.each([
    "memberships",
    "treasuries",
    "contractors",
    "payout_destinations",
    "payee_approvals",
    "payee_registry_heads",
    "pay_runs",
    "pay_run_items",
    "payout_attempts",
  ])("%s has a required org_id", async (table) => {
    expect((await columnsOf(table)).org_id).toBe("NO");
  });

  it("audit_log allows no org_id only for auth events", async () => {
    const entry = { actor: "a", entity: "e", entityId: "1" };
    await db.insert(auditLog).values({ ...entry, action: "auth.sign_in" });
    const err = await rejection(() =>
      db.insert(auditLog).values({ ...entry, action: "org.create" }),
    );
    expect(err.constraint).toBe("audit_log_org_required_except_auth");
  });

  it("creates every table the schema calls for", async () => {
    const result = await db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(result.rows.map((r) => r.table_name).sort()).toEqual(
      [
        "audit_log",
        "auth_challenges",
        "contractors",
        "encumbrances",
        "memberships",
        "organizations",
        "pay_run_items",
        "pay_runs",
        "payee_approvals",
        "payee_registry_heads",
        "payee_requests",
        "payout_attempts",
        "org_data_keys",
        "payout_destinations",
        "sessions",
        "sessions_1click",
        "sign_requests",
        "treasuries",
        "treasury_events",
        "treasury_session_requests",
        "users",
      ].sort(),
    );
  });

  it("rejects an unknown mode", async () => {
    const { orgId, itemId } = await seedLineItem(db);
    const err = await rejection(() =>
      db.execute(
        sql`INSERT INTO payout_attempts (org_id, line_item_id, attempt_no, status, mode) VALUES (${orgId}, ${itemId}, 1, 'PLANNED', 'pretend')`,
      ),
    );
    expect(err.code).toBe("22P02");
  });
});

describe("database and core stay in step", () => {
  async function enumValues(name: string) {
    const result = await db.execute<{ enumlabel: string }>(
      sql`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = ${name} ORDER BY e.enumsortorder`,
    );
    return result.rows.map((r) => r.enumlabel);
  }

  it("the enums match core's lists", async () => {
    expect(await enumValues("attempt_status")).toEqual([...ATTEMPT_STATUSES]);
    expect(await enumValues("pay_run_status")).toEqual([...PAY_RUN_STATUSES]);
    expect(await enumValues("mode")).toEqual([...MODES]);
  });
});
