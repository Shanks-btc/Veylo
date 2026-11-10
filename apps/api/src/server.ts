import { randomBytes } from "node:crypto";
import { createIntentsReader, createNearRpc } from "@veylo/chains";
import { loadApiConfig } from "@veylo/config";
import { schema } from "@veylo/db";
import { createOneClickDryClient, createOneClickTreasuryClient } from "@veylo/intents";
import { createSecretBox } from "@veylo/secrets";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { buildServer } from "./app.js";
import { installShutdown } from "./lifecycle.js";

const config = loadApiConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
// An idle client losing its connection must not crash the process; /ready reports it instead.
pool.on("error", () => {});

const app = await buildServer({
  db: drizzle(pool, { schema }),
  clock: () => new Date(),
  random: (bytes) => randomBytes(bytes),
  rpc: createNearRpc({ url: config.NEAR_RPC_URL, fetch: globalThis.fetch }),
  oneclick: createOneClickDryClient({
    apiKey: config.ONECLICK_PARTNER_KEY,
    fetch: globalThis.fetch,
  }),
  oneclickTreasury: createOneClickTreasuryClient({
    apiKey: config.ONECLICK_PARTNER_KEY,
    fetch: globalThis.fetch,
    quotePublicKey: config.ONECLICK_QUOTE_PUBLIC_KEY,
  }),
  intents: createIntentsReader({ url: config.NEAR_RPC_URL, fetch: globalThis.fetch }),
  secrets: createSecretBox({
    masterKey: config.SESSION_ENCRYPTION_KEY,
    random: (bytes) => randomBytes(bytes),
  }),
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
  },
});

// Graceful shutdown: stop accepting connections and let in-flight requests finish (app.close), then
// close the database pool. SIGTERM, SIGINT, or an IPC "shutdown" message (Windows test runs).
installShutdown({
  steps: [
    { name: "http", run: () => app.close() },
    { name: "database", run: () => pool.end() },
  ],
  log: app.log,
  exit: (code) => process.exit(code),
  target: process,
});

await app.listen({ host: "0.0.0.0", port: config.PORT });
