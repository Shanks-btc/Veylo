// The hosted deployment's replacement for the long-running worker (W7). On Vercel nothing runs
// between requests, so the same idempotent sweeps run in two ways:
//   - from a Vercel Cron call (cron-routes.ts), for every organisation, once a day on the free plan;
//   - on demand, for one organisation, when someone opens a page that shows payout status.
// Neither path can quote, sign or submit anything new. Settlement only follows up payloads a
// treasury wallet already signed; the scheduler has a database and a clock and nothing else.
import type { CronJobs, CronLog } from "./cron-routes.js";
import {
  CRON_CUTOFF_SECONDS,
  FUNCTION_MAX_DURATION_SECONDS,
  SAFETY_MARGIN_SECONDS,
  SWEEP_ROW_WORST_CASE_SECONDS,
} from "./function-limits.mjs";
import type { createScheduler } from "./scheduler.js";
import type { createSettlement } from "./settlement.js";

type Settlement = ReturnType<typeof createSettlement>;
type Scheduler = ReturnType<typeof createScheduler>;
type Scope = { orgId?: string; shouldStop?: () => boolean };

/**
 * The settlement cron starts no new row after this long. It must leave room for the worst row that
 * could already be running, plus a margin, inside the function's limit: checked by hosted.test.ts
 * against the number the deployment is built with.
 */
export const CRON_CUTOFF_MS = CRON_CUTOFF_SECONDS * 1000;
export const FUNCTION_LIMIT_MS = FUNCTION_MAX_DURATION_SECONDS * 1000;
export const WORST_ROW_MS = SWEEP_ROW_WORST_CASE_SECONDS * 1000;
export const SAFETY_MARGIN_MS = SAFETY_MARGIN_SECONDS * 1000;

export type SweepResult = { name: string; status: "ok" | "failed" | "deferred" };

export type HostedOptions = {
  settlement: Pick<
    Settlement,
    | "pollPayoutStatus"
    | "resolveUncertainSubmits"
    | "expireQuotes"
    | "reconcilePayouts"
    | "releaseEncumbrances"
  >;
  scheduler: Pick<Scheduler, "prepareDue">;
  clock: () => Date;
  log: CronLog;
  /** A cron call starts no new row after this long. Default: CRON_CUTOFF_MS (60 s of a 120 s limit). */
  cronBudgetMs?: number;
  /** A status page waits at most this long for its refresh before it reads what is stored. */
  refreshWaitMs?: number;
  /** A status page refreshes an organisation at most this often. */
  refreshEveryMs?: number;
};

export function createHostedJobs(options: HostedOptions) {
  const { settlement, scheduler, clock, log } = options;
  const cronBudgetMs = options.cronBudgetMs ?? CRON_CUTOFF_MS;
  const refreshWaitMs = options.refreshWaitMs ?? 8_000;
  const refreshEveryMs = options.refreshEveryMs ?? 10_000;

  const SWEEPS: readonly [string, (l: CronLog, scope: Scope) => Promise<void>][] = [
    ["poll-payout-status", (l, s) => settlement.pollPayoutStatus(l, s)],
    ["resolve-uncertain-submit", (l, s) => settlement.resolveUncertainSubmits(l, s)],
    ["expire-quotes", (l, s) => settlement.expireQuotes(l, s)],
    ["reconcile-payout", (l, s) => settlement.reconcilePayouts(l, s)],
    ["release-encumbrances", (l, s) => settlement.releaseEncumbrances(l, s)],
  ];

  /**
   * One failing sweep never stops the rest. Past the deadline no new sweep and no new row starts: a
   * sweep that stopped early, or never started, is reported as deferred. A row already begun finishes.
   */
  async function runSweeps(
    scope: Omit<Scope, "shouldStop">,
    deadlineMs: number,
  ): Promise<SweepResult[]> {
    const stop = clock().getTime() + deadlineMs;
    let cut = false;
    const shouldStop = () => {
      if (clock().getTime() < stop) return false;
      cut = true;
      return true;
    };
    const results: SweepResult[] = [];
    for (const [name, run] of SWEEPS) {
      if (shouldStop()) {
        results.push({ name, status: "deferred" });
        continue;
      }
      try {
        await run(log, { ...scope, shouldStop });
        results.push({ name, status: cut ? "deferred" : "ok" });
      } catch (err) {
        log.error({ err, sweep: name }, "sweep failed");
        results.push({ name, status: "failed" });
      }
    }
    return results;
  }

  const jobs: CronJobs = {
    "prepare-drafts": async (l) => {
      const { created } = await scheduler.prepareDue(l);
      return { created };
    },
    settlement: async () => {
      const steps = await runSweeps({}, cronBudgetMs);
      // A failed or deferred sweep makes the call a failure, so Vercel's cron log shows it.
      if (steps.some((s) => s.status !== "ok")) {
        log.error({ steps }, "settlement cron did not finish every sweep");
        throw new Error("settlement sweeps incomplete");
      }
      return { steps };
    },
  };

  const lastStart = new Map<string, number>();
  const running = new Map<string, Promise<unknown>>();

  /** Never throws, never waits longer than `refreshWaitMs`. */
  async function refresh(orgId: string): Promise<void> {
    const now = clock().getTime();
    const last = lastStart.get(orgId);
    if (last !== undefined && now - last < refreshEveryMs) return;
    let work = running.get(orgId);
    if (!work) {
      lastStart.set(orgId, now);
      work = runSweeps({ orgId }, refreshWaitMs)
        .catch((err: unknown) => log.error({ err }, "status refresh failed"))
        .finally(() => running.delete(orgId));
      running.set(orgId, work);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, refreshWaitMs);
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return { jobs, refresh, runSweeps, cronBudgetMs };
}
