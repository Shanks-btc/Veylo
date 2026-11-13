// The scheduled-payroll job (slice W5, D1). Three days before payday it prepares a draft pay run
// and marks it "Ready for review". That is all it does.
//
// It NEVER quotes, signs or submits. This is enforced by its dependencies, not by good intentions:
// the job receives only a database handle and a clock. It has no 1Click client, no wallet and no
// route into settlement, so it can't reach a quote even by mistake. scheduler.test.ts also reads
// this file and fails if any such name appears in it.
import { PREPARE_DAYS_BEFORE, paydaysDue, periodOf, type Schedule } from "@veylo/core";
import {
  insertPayRunItem,
  insertScheduledDraft,
  listActiveSchedules,
  listContractors,
  setPayRunStatus,
  writeAudit,
  type Db,
} from "@veylo/db";

export type SchedulerDeps = { db: Db; clock: () => Date };

/**
 * The reminder hook. Email is stubbed behind a flag that is off: nothing leaves the building until
 * someone turns it on and supplies `send`.
 */
export type Reminder = {
  enabled: boolean;
  send(r: { orgId: string; period: string; payday: string }): Promise<void>;
};
export const NO_REMINDER: Reminder = { enabled: false, send: async () => {} };

type Log = { info(o: object, m: string): void; error(o: object, m: string): void };

const UNITS = /^[1-9]\d{0,18}$/;

export function createScheduler(deps: SchedulerDeps, reminder: Reminder = NO_REMINDER) {
  return {
    /** Idempotent: a draft exists once per organisation and payday, however often this runs. */
    async prepareDue(log: Log): Promise<{ created: number }> {
      const now = deps.clock();
      let created = 0;
      for (const row of await listActiveSchedules(deps.db)) {
        const schedule: Schedule =
          row.kind === "monthly"
            ? { kind: "monthly", dayOfMonth: row.dayOfMonth as number, timeZone: row.timeZone }
            : { kind: "biweekly", anchorDate: row.anchorDate as string, timeZone: row.timeZone };
        for (const payday of paydaysDue(schedule, now)) {
          const draft = await deps.db.transaction(async (tx) => {
            const run = await insertScheduledDraft(tx, {
              orgId: row.orgId,
              period: periodOf(payday),
              scheduledFor: payday,
              readyAt: now,
            });
            if (!run) return undefined; // Already prepared for this payday.
            let total = 0n;
            for (const c of await listContractors(tx, row.orgId)) {
              const terms = c.terms as { kind?: string; rate?: string; schedule?: string };
              // A fixed rate on the same rhythm as the schedule; hourly work needs a person.
              if (c.status !== "active" || terms.kind !== "fixed") continue;
              if (terms.schedule !== row.kind) continue;
              if (typeof terms.rate !== "string" || !UNITS.test(terms.rate)) continue;
              const item = await insertPayRunItem(tx, {
                orgId: row.orgId,
                payRunId: run.id,
                contractorId: c.id,
                amountUsdc: BigInt(terms.rate),
                basis: { scheduled: true, rate: terms.rate },
                mode: "live",
              });
              if (item) total += item.amountUsdc;
            }
            await setPayRunStatus(tx, row.orgId, run.id, "Draft", "Draft", total);
            await writeAudit(tx, {
              orgId: row.orgId,
              actor: "scheduler",
              action: "pay_run.scheduled_draft",
              entity: "pay_run",
              entityId: run.id,
              at: now,
            });
            return run;
          });
          if (!draft) continue;
          created += 1;
          log.info(
            {
              orgId: row.orgId,
              payRunId: draft.id,
              payday,
              prepareDaysBefore: PREPARE_DAYS_BEFORE,
            },
            "scheduled draft prepared, ready for review",
          );
          if (reminder.enabled) {
            await reminder
              .send({ orgId: row.orgId, period: draft.period, payday })
              .catch((err: unknown) => log.error({ err }, "reminder failed"));
          }
        }
      }
      return { created };
    },
  };
}
