// The agent worker (slice 8). It loads the agent key only, never the session key (L31, L36), and has
// no jobs yet: agent payments arrive in slice 8. Like the settlement worker, it refuses to start while
// migrations are pending or unreadable (L38).
import { loadWorkerConfig } from "@veylo/config";
import { schema } from "@veylo/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import pino from "pino";
import { loggerOptions } from "./logging.js";
import { migrationGuard } from "./startup-guard.js";

const config = loadWorkerConfig();
const log = pino(loggerOptions(config.LOG_LEVEL) as never);
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
pool.on("error", () => {});
const ok = await migrationGuard(drizzle(pool, { schema }), log, "worker:agents");
await pool.end().catch(() => {});
if (!ok) process.exit(1);
log.info({}, "worker:agents has no jobs until slice 8. Exiting.");
