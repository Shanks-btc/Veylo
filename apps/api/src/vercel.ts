// The API as a Vercel Function (W7). The same Fastify app as server.ts, behind `(req, res)`:
// no route changes. The function is built once per instance, on its first request, and reused.
//
// What differs from the long-running server:
//   - there is no pg-boss worker; Vercel Cron calls the internal routes (cron-routes.ts), and status
//     pages refresh on demand (hosted.ts);
//   - the database pool is small and short-lived, since each instance serves few requests at once;
//   - a missing or invalid setting answers 503 "not configured" to everyone and logs which names
//     are wrong (never a value), instead of crashing the build.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createIntentsReader, createNearRpc } from "@veylo/chains";
import { ConfigError, loadApiConfig } from "@veylo/config";
import { schema } from "@veylo/db";
import { createSecretBox } from "@veylo/secrets";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import pino from "pino";
import { buildServer } from "./app.js";
import { createFxClient } from "./fx.js";
import { createHostedJobs } from "./hosted.js";
import { loggerOptions } from "./logging.js";
import { createOneClickClients } from "./oneclick-clients.js";
import { createScheduler } from "./scheduler.js";
import { createSettlement } from "./settlement.js";

async function create(): Promise<FastifyInstance> {
  const config = loadApiConfig();
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  // An idle client losing its connection must not crash the instance; /ready reports it instead.
  pool.on("error", () => {});
  const db = drizzle(pool, { schema });
  const clock = () => new Date();
  const random = (bytes: number) => randomBytes(bytes);
  const rpc = createNearRpc({ url: config.NEAR_RPC_URL, fetch: globalThis.fetch });
  const intents = createIntentsReader({ url: config.NEAR_RPC_URL, fetch: globalThis.fetch });
  const secrets = createSecretBox({ masterKey: config.SESSION_ENCRYPTION_KEY, random });

  // Without the partner key every live-quote feature says so and fails closed.
  const { oneclick, oneclickTreasury, connected } = createOneClickClients({
    partnerKey: config.ONECLICK_PARTNER_KEY,
    quotePublicKey: config.ONECLICK_QUOTE_PUBLIC_KEY,
    fetch: globalThis.fetch,
  });

  const log = pino(loggerOptions(config.LOG_LEVEL, undefined, false) as never);
  const hosted = createHostedJobs({
    settlement: createSettlement({
      db,
      clock,
      oneclickTreasury,
      intents,
      rpc,
      secrets,
      config: {} as never,
    }),
    // The scheduled-payroll job gets a database and a clock only (D1): it can't quote, sign or submit.
    scheduler: createScheduler({ db, clock }),
    clock,
    log,
  });

  const app = await buildServer({
    db,
    clock,
    random,
    rpc,
    oneclick,
    oneclickTreasury,
    intents,
    fx: createFxClient({ fetch: globalThis.fetch, clock }),
    secrets,
    ...(config.CRON_SECRET ? { cron: { secret: config.CRON_SECRET, jobs: hosted.jobs } } : {}),
    refresh: hosted.refresh,
    config: {
      authRecipient: config.AUTH_RECIPIENT,
      webOrigin: config.WEB_ORIGIN,
      sessionTtlHours: config.SESSION_TTL_HOURS,
      logLevel: config.LOG_LEVEL,
      trustProxyHops: config.TRUST_PROXY_HOPS,
      logClientIp: config.LOG_CLIENT_IP,
      treasuryLimitPerOrgPerHour: config.TREASURY_LIMIT_ORG_PER_HOUR,
      treasuryLimitPerUserPerHour: config.TREASURY_LIMIT_USER_PER_HOUR,
      payoutQuoteDeadlineMinutes: config.PAYOUT_QUOTE_DEADLINE_MINUTES,
      reviewDeviationPercent: config.REVIEW_AMOUNT_DEVIATION_PERCENT,
      liveQuotes: connected,
      fundingQuotes: true,
      // No email provider is wired. The screens say "Email delivery is not set up yet".
      emailDelivery: false,
    },
  });
  await app.ready();
  return app;
}

let instance: Promise<FastifyInstance> | undefined;

function notConfigured(res: ServerResponse) {
  res.statusCode = 503;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ error: { code: "NOT_CONFIGURED", message: "Not configured" } }));
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    instance ??= create();
    const app = await instance;
    app.server.emit("request", req, res);
  } catch (err) {
    instance = undefined; // The next request tries again.
    // Names only: a ConfigError never holds a value, and nothing else is logged here.
    console.error(
      err instanceof ConfigError ? err.message : "the API could not start",
      err instanceof ConfigError ? "" : (err as Error)?.name,
    );
    notConfigured(res);
  }
}
