// Internal cron routes (W7). On Vercel there is no long-running worker: Vercel Cron calls these
// routes on a schedule and sends `Authorization: Bearer <CRON_SECRET>`. Every call is checked
// against the secret, in constant time, and anything else is refused before any work starts.
//
// The jobs are the same idempotent sweeps the pg-boss worker runs (settlement.ts, scheduler.ts), so
// a call delivered twice, or two calls at once, change nothing the second time. They are wired in
// vercel.ts. Neither job can quote, sign or submit anything new: settlement only follows up what a
// treasury wallet already signed, and the scheduler has a database and a clock and nothing else.
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Deps } from "./app.js";
import { unauthenticated } from "./errors.js";

export type CronLog = {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
};
export const CRON_JOB_NAMES = ["prepare-drafts", "settlement"] as const;
export type CronJobName = (typeof CRON_JOB_NAMES)[number];
export type CronJobs = Record<CronJobName, (log: CronLog) => Promise<Record<string, unknown>>>;

const digest = (text: string) => createHash("sha256").update(text).digest();

/** True only for exactly `Bearer <secret>`. Compares fixed-length digests, so timing says nothing. */
export function bearerMatches(header: unknown, secret: string): boolean {
  if (typeof header !== "string") return false;
  const m = /^Bearer (\S+)$/.exec(header);
  const presented = digest(m?.[1] ?? "");
  const expected = digest(secret);
  // Always compare, so a missing or malformed header takes the same path as a wrong secret.
  return timingSafeEqual(presented, expected) && m !== null;
}

export async function cronRoutes(app: FastifyInstance, deps: Deps) {
  const cron = deps.cron;
  if (!cron) return;

  const refuse = (request: FastifyRequest) => {
    if (!bearerMatches(request.headers.authorization, cron.secret)) throw unauthenticated();
  };

  for (const name of CRON_JOB_NAMES) {
    // Vercel Cron makes GET requests. Few attempts per minute: the secret is long and random, so
    // this only keeps a guessing run cheap to refuse.
    app.get(
      `/internal/cron/${name}`,
      { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
      async (request, reply) => {
        refuse(request);
        const started = deps.clock().getTime();
        const result = await cron.jobs[name](request.log);
        request.log.info({ job: name, ms: deps.clock().getTime() - started }, "cron job finished");
        reply.header("cache-control", "no-store");
        return { ok: true as const, job: name, ...result };
      },
    );
  }
}
