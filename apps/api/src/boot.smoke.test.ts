// Boot smoke tests (slice 6.1): the built server and settlement worker, started as real processes
// against real Postgres. Run by `pnpm test:pg`, which builds first.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const bin = (name: string) => join(root, "apps", "api", "dist", "bin", `${name}.js`);
const admin = process.env.DATABASE_URL as string;

async function freshDatabase() {
  const name = `veylo_smoke_${randomUUID().replaceAll("-", "")}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return {
    url: url.href,
    async drop() {
      const d = new pg.Client({ connectionString: admin });
      await d.connect();
      await d.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await d.end();
    },
  };
}

function env(databaseUrl: string, port: number) {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    ONECLICK_PARTNER_KEY: "smoke-test-not-a-key",
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    NODE_ENV: "development",
    LOG_LEVEL: "info",
    AUTH_RECIPIENT: "veylo.test",
    WEB_ORIGIN: "http://localhost:5173",
    PORT: String(port),
  };
}

/** Every Veylo variable removed from the parent environment, then only the given ones set. */
const VEYLO_NAMES =
  /^(DATABASE_URL|ONECLICK_|NEARAI_|SESSION_|AGENT_KEY_|NODE_ENV|LOG_|NEAR_RPC_URL|AUTH_RECIPIENT|WEB_ORIGIN|PORT|TRUST_PROXY_HOPS|TREASURY_LIMIT_|PAYOUT_QUOTE_|REVIEW_AMOUNT_)/;
function only(vars: Record<string, string>): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !VEYLO_NAMES.test(k)),
  );
  return { ...base, ...vars };
}
/** The settlement worker's own set (L38): no AUTH_RECIPIENT, WEB_ORIGIN or PORT. */
const settlementEnv = (url: string) =>
  only({
    DATABASE_URL: url,
    ONECLICK_PARTNER_KEY: "smoke-test-not-a-key",
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    NODE_ENV: "development",
    LOG_LEVEL: "info",
  });

/** Real processes. On Windows a parent can't send SIGTERM, so the IPC path calls the same handler. */
function start(name: string, e: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [bin(name)], {
    env: e,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", (d) => (output += String(d)));
  child.stderr?.on("data", (d) => (output += String(d)));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, exited, output: () => output };
}
function stop(child: ChildProcess) {
  if (process.platform === "win32") child.send("shutdown");
  else child.kill("SIGTERM");
}
async function waitFor(fn: () => Promise<boolean>, ms = 30_000, output?: () => string) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `timed out waiting${
      output
        ? `. Process output:
${output().slice(-2000)}`
        : ""
    }`,
  );
}
const migrate = (url: string) =>
  new Promise<number | null>((r) =>
    spawn(process.execPath, [bin("migrate")], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "ignore",
    }).on("exit", r),
  );

describe.runIf(process.env.VEYLO_TEST_PG)("boot smoke tests (built JS, real processes)", () => {
  it("the build exists", () => {
    for (const n of ["server", "worker", "worker-agents", "migrate"])
      expect(existsSync(bin(n))).toBe(true);
  });

  it("server: /health, then /ready is 503 until migrated and 200 after, then a clean SIGTERM exit", async () => {
    const db = await freshDatabase();
    try {
      const port = 39000 + Math.floor(Math.random() * 1000);
      const base = `http://127.0.0.1:${port}`;
      let s = start("server", env(db.url, port));
      await waitFor(async () => (await fetch(`${base}/health`)).status === 200, 30_000, s.output);
      const notReady = await fetch(`${base}/ready`);
      expect(notReady.status).toBe(503);
      expect(await notReady.json()).toMatchObject({
        status: "not_ready",
        reason: expect.stringMatching(/^migrations_pending/),
      });
      stop(s.child);
      expect(await s.exited).toBe(0);

      expect(await migrate(db.url)).toBe(0);
      s = start("server", env(db.url, port));
      await waitFor(async () => (await fetch(`${base}/health`)).status === 200, 30_000, s.output);
      const ready = await fetch(`${base}/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ready" });
      stop(s.child);
      expect(await s.exited).toBe(0);
      expect(s.output()).toContain("shut down");
      await expect(fetch(`${base}/health`)).rejects.toThrow();
    } finally {
      await db.drop();
    }
  });

  it("settlement worker, with only its own variables: refuses an unmigrated database (exit 1), then starts, registers its jobs and stops cleanly", async () => {
    const db = await freshDatabase();
    try {
      const e = settlementEnv(db.url);
      const refused = start("worker", e);
      expect(await refused.exited).toBe(1);
      expect(refused.output()).toMatch(
        /worker:settlement refusing to start: migrations_pending: \d+/,
      );
      expect(refused.output()).not.toContain(db.url);
      expect(refused.output()).not.toContain("veylo_ci");

      expect(await migrate(db.url)).toBe(0);
      const w = start("worker", e);
      await waitFor(async () => w.output().includes("worker:settlement started"), 30_000, w.output);
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      const queues = (await c.query("select name from pgboss.queue order by name")).rows.map(
        (r) => r.name,
      );
      await c.end();
      expect(queues).toEqual(
        expect.arrayContaining([
          "expire-quotes",
          "poll-payout-status",
          "reconcile-payout",
          "release-encumbrances",
          "resolve-uncertain-submit",
        ]),
      );
      stop(w.child);
      expect(await w.exited).toBe(0);
      expect(w.output()).toContain("shut down");
    } finally {
      await db.drop();
    }
  });

  it.each([
    ["worker", "worker:settlement"],
    ["worker-agents", "worker:agents"],
  ])(
    "%s: an unreachable database exits 1 with database_unreachable, never the URL or password",
    async (bin, name) => {
      const url = "postgres://veylo:hunter2-sentinel@127.0.0.1:1/veylo";
      const e =
        bin === "worker"
          ? settlementEnv(url)
          : only({
              DATABASE_URL: url,
              ONECLICK_PARTNER_KEY: "smoke-test-not-a-key",
              NEARAI_API_KEY: "sk-smoke-not-a-key",
              AGENT_KEY_MASTER_KEY: randomBytes(32).toString("base64"),
              NODE_ENV: "development",
              LOG_LEVEL: "info",
            });
      const w = start(bin, e);
      expect(await w.exited).toBe(1);
      expect(w.output()).toContain(`${name} refusing to start: database_unreachable`);
      expect(w.output()).not.toContain("hunter2-sentinel");
      expect(w.output()).not.toContain(url);
    },
  );

  it("agents worker, with only its own variables: refuses an unmigrated database, then exits 0 once migrated", async () => {
    const db = await freshDatabase();
    try {
      const e = only({
        DATABASE_URL: db.url,
        ONECLICK_PARTNER_KEY: "smoke-test-not-a-key",
        NEARAI_API_KEY: "sk-smoke-not-a-key",
        AGENT_KEY_MASTER_KEY: randomBytes(32).toString("base64"),
        NODE_ENV: "development",
        LOG_LEVEL: "info",
      });
      const refused = start("worker-agents", e);
      expect(await refused.exited).toBe(1);
      expect(refused.output()).toMatch(/worker:agents refusing to start: migrations_pending: \d+/);
      expect(refused.output()).not.toContain(db.url);

      expect(await migrate(db.url)).toBe(0);
      const a = start("worker-agents", e);
      expect(await a.exited).toBe(0);
      expect(a.output()).toContain("no jobs until slice 8");
    } finally {
      await db.drop();
    }
  });
});
