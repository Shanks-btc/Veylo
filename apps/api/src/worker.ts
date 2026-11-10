// The settlement worker (slice 5b): pg-boss runs each job on a schedule. Every job is a sweep that
// is safe to run twice, so pg-boss's at-least-once delivery can't do harm.
import { randomBytes } from "node:crypto";
import { createIntentsReader, createNearRpc } from "@veylo/chains";
import { loadSettlementWorkerConfig } from "@veylo/config";
import { schema } from "@veylo/db";
import { createOneClickDryClient, createOneClickTreasuryClient } from "@veylo/intents";
import { createSecretBox } from "@veylo/secrets";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { PgBoss } from "pg-boss";
import pino from "pino";
import { installShutdown } from "./lifecycle.js";
import { loggerOptions } from "./logging.js";
import { createSettlement } from "./settlement.js";
import { migrationGuard } from "./startup-guard.js";

const config = loadSettlementWorkerConfig();
const log = pino(loggerOptions(config.LOG_LEVEL) as never);
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
pool.on("error", (err) => log.error({ err }, "database pool error"));

const settlement = createSettlement({
  db: drizzle(pool, { schema }),
  clock: () => new Date(),
  oneclickTreasury: createOneClickTreasuryClient({
    apiKey: config.ONECLICK_PARTNER_KEY,
    fetch: globalThis.fetch,
    quotePublicKey: config.ONECLICK_QUOTE_PUBLIC_KEY,
  }),
  intents: createIntentsReader({ url: config.NEAR_RPC_URL, fetch: globalThis.fetch }),
  rpc: createNearRpc({ url: config.NEAR_RPC_URL, fetch: globalThis.fetch }),
  secrets: createSecretBox({
    masterKey: config.SESSION_ENCRYPTION_KEY,
    random: (bytes) => randomBytes(bytes),
  }),
  config: {} as never,
});
void createOneClickDryClient;

import { createWorkerShutdownSteps } from "./worker-shutdown.js";

export const JOBS = {
  "poll-payout-status": settlement.pollPayoutStatus,
  "reconcile-payout": settlement.reconcilePayouts,
  "resolve-uncertain-submit": settlement.resolveUncertainSubmits,
  "expire-quotes": settlement.expireQuotes,
  "release-encumbrances": settlement.releaseEncumbrances,
} as const;

// No job or ticker starts until every migration is applied (L38).
if (!(await migrationGuard(drizzle(pool, { schema }), log, "worker:settlement"))) {
  await pool.end().catch(() => {});
  process.exit(1);
}

const boss = new PgBoss(config.DATABASE_URL);
boss.on("error", (err) => log.error({ err }, "pg-boss error"));
await boss.start();
for (const [name, run] of Object.entries(JOBS)) {
  await boss.createQueue(name);
  await boss.work(name, async () => {
    await run(log);
  });
  // Once a minute at least, even if the ticker below stops.
  await boss.schedule(name, "* * * * *");
}
// Payouts settle in seconds (T5), so each sweep is also queued every 10 s, one at a time per job.
const ticker = setInterval(() => {
  for (const name of Object.keys(JOBS)) {
    void boss.send(name, {}, { singletonKey: name, singletonSeconds: 10 });
  }
}, 10_000);

log.info({ jobs: Object.keys(JOBS) }, "worker:settlement started");

// Graceful shutdown: stop queueing, then stop pg-boss gracefully (no new jobs fetched; in-flight
// jobs finish, and any still running at the timeout are left for pg-boss to retry after expiry;
// every job is an idempotent sweep), then close the database pool.
installShutdown({
  steps: createWorkerShutdownSteps({ ticker, boss, pool }),
  log,
  exit: (code) => process.exit(code),
  target: process,
});
