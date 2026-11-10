// GET /health (liveness) and GET /ready (database + migrations), slice 6.1, and the settlement
// worker's shutdown order.
import { checkReadiness } from "@veylo/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type App } from "./test-support.js";
import { createWorkerShutdownSteps } from "./worker-shutdown.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

describe("GET /health and GET /ready", () => {
  it("/health is liveness only", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("/ready is 200 when the database answers and every migration is applied", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });

  it("/ready is 503 when a migration is pending", async () => {
    const [last] = (
      (await h.db.execute(
        sql`select id, hash, created_at::text as at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
      )) as unknown as { rows: { id: number; hash: string; at: string }[] }
    ).rows;
    await h.db.execute(sql`delete from drizzle.__drizzle_migrations where id = ${last!.id}`);
    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: "not_ready", reason: "migrations_pending: 1" });
    } finally {
      await h.db.execute(
        sql`insert into drizzle.__drizzle_migrations (id, hash, created_at) values (${last!.id}, ${last!.hash}, ${last!.at}::bigint)`,
      );
    }
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
  });

  it("is 503 database_unreachable when the database fails, and never leaks the error", async () => {
    const secret = "postgres://veylo:hunter2@db.internal:5432/veylo";
    const broken = {
      execute: async () => Promise.reject(new Error(`connect ECONNREFUSED ${secret}`)),
    };
    const r = await checkReadiness(broken as never);
    expect(r).toEqual({ ready: false, reason: "database_unreachable" });
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("is 503 when the migration table can't be read", async () => {
    let n = 0;
    const flaky = {
      execute: async () => {
        n += 1;
        if (n === 1) return { rows: [] };
        throw new Error("permission denied for schema drizzle");
      },
    };
    expect(await checkReadiness(flaky as never)).toEqual({
      ready: false,
      reason: "migration_state_unreadable",
    });
  });

  it("with no migration table at all, every migration is pending", async () => {
    let n = 0;
    const empty = { execute: async () => (++n === 1 ? { rows: [] } : { rows: [{ name: null }] }) };
    const r = await checkReadiness(empty as never);
    expect(r.ready).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/^migrations_pending: \d+$/);
  });
});

describe("settlement worker shutdown", () => {
  it("stops the ticker, then pg-boss gracefully, then the pool", async () => {
    const order: string[] = [];
    const ticker = setInterval(() => order.push("tick"), 1);
    const boss = { stop: vi.fn(async () => void order.push("boss")) };
    const pool = { end: vi.fn(async () => void order.push("pool")) };
    for (const step of createWorkerShutdownSteps({ ticker, boss, pool, stopTimeoutMs: 1234 })) {
      await step.run();
    }
    const after = order.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(order.length).toBe(after); // The ticker is stopped.
    expect(order.filter((x) => x !== "tick")).toEqual(["boss", "pool"]);
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true, close: true, timeout: 1234 });
  });
});

describe("worker start guard: database unreachable (L39)", () => {
  it("refuses with reason database_unreachable, and the log line has no URL or password", async () => {
    const { migrationGuard } = await import("./startup-guard.js");
    const url = "postgres://veylo:hunter2-sentinel@db.internal:5432/veylo";
    const broken = {
      execute: async () => Promise.reject(new Error(`connect ECONNREFUSED ${url}`)),
    };
    const lines: string[] = [];
    const log = {
      error: (o: object, m: string) => void lines.push(JSON.stringify({ ...o, msg: m })),
    };
    expect(await migrationGuard(broken as never, log, "worker:settlement")).toBe(false);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      reason: "database_unreachable",
      msg: "worker:settlement refusing to start: database_unreachable",
    });
    expect(lines[0]).not.toContain("hunter2-sentinel");
    expect(lines[0]).not.toContain("db.internal");
  });
});
