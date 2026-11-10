// Test support only. Not exported from the main entry of the package.
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { migrationsFolder } from "./index.js";
import * as schema from "./schema.js";

type Created = {
  db: PgliteDatabase<typeof schema>;
  client: { close(): Promise<void> };
};

/**
 * `pnpm test:pg`: a new database on the server in DATABASE_URL, dropped on close. Only databases
 * created here are ever written to or dropped, never the one the URL names.
 */
async function createPostgresDb(adminUrl: string): Promise<Created> {
  const name = `veylo_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.href });
  const db = drizzlePg(pool, { schema });
  await migratePg(db, { migrationsFolder });

  return {
    // The two drivers share the query API. Only the result type parameter differs.
    db: db as unknown as Created["db"],
    client: {
      async close() {
        await pool.end();
        const dropper = new pg.Client({ connectionString: adminUrl });
        await dropper.connect();
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await dropper.end();
      },
    },
  };
}

/**
 * A new database with every migration applied. By default it's an in-memory PGlite, needing no
 * Docker, install or network.
 */
export async function createTestDb(): Promise<Created> {
  if (process.env.VEYLO_TEST_PG) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("VEYLO_TEST_PG needs DATABASE_URL");
    return createPostgresDb(url);
  }
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db, client };
}

export type TestDb = Created["db"];

/** Inserts the chain of parents a payout attempt needs, and returns their IDs. */
export async function seedLineItem(db: TestDb, mode: "live" | "simulated" = "simulated") {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  if (!org) throw new Error("no org");
  const [contractor] = await db
    .insert(schema.contractors)
    .values({
      orgId: org.id,
      name: "C",
      email: "c@example.com",
      terms: {},
      payoutMode: "direct",
      status: "active",
    })
    .returning();
  if (!contractor) throw new Error("no contractor");
  const [destination] = await db
    .insert(schema.payoutDestinations)
    .values({
      orgId: org.id,
      contractorId: contractor.id,
      route: "usdc-base",
      payoutMode: "direct",
      chain: "base",
      assetId: "a",
      address: "0x1",
    })
    .returning();
  if (!destination) throw new Error("no destination");
  const [run] = await db
    .insert(schema.payRuns)
    .values({
      orgId: org.id,
      period: "2026-11",
      status: "Quoting",
      preparedBy: "user",
      totalAmountUsdc: 100n,
      mode,
    })
    .returning();
  if (!run) throw new Error("no run");
  let firstItem = true;
  const addItem = async () => {
    // One item per contractor per run, so each later item gets a run of its own.
    let payRunId = run.id;
    if (!firstItem) {
      const [extra] = await db
        .insert(schema.payRuns)
        .values({
          orgId: org.id,
          period: "2026-11",
          status: "Quoting",
          preparedBy: "user",
          totalAmountUsdc: 100n,
          mode,
        })
        .returning();
      if (!extra) throw new Error("no run");
      payRunId = extra.id;
    }
    firstItem = false;
    const [item] = await db
      .insert(schema.payRunItems)
      .values({
        orgId: org.id,
        payRunId,
        contractorId: contractor.id,
        destinationId: destination.id,
        amountUsdc: 100n,
        basis: {},
        mode,
      })
      .returning();
    if (!item) throw new Error("no item");
    return item.id;
  };
  return {
    orgId: org.id,
    contractorId: contractor.id,
    destinationId: destination.id,
    payRunId: run.id,
    itemId: await addItem(),
    addItem,
  };
}
