// The organisation's payroll schedule (slice W5, D1): when drafts are prepared, and pause and
// resume. Only the owner changes it; everyone in the organisation can see it.
import { isValidTimeZone, nextPayday, type Schedule } from "@veylo/core";
import { getSchedule, setSchedulePaused, upsertSchedule, writeAudit } from "@veylo/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, type Deps } from "./app.js";
import { AppError, notFound } from "./errors.js";
import type { Guards } from "./guards.js";

const OWNER_ONLY = ["owner"] as const;
const orgParams = z.object({ orgId: z.uuid() });

const timeZone = z.string().max(64).refine(isValidTimeZone, "not a time zone");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
      new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
    "not a date",
  );
const putBody = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("monthly"), dayOfMonth: z.number().int().min(1).max(31), timeZone })
    .strict(),
  z.object({ kind: z.literal("biweekly"), anchorDate: date, timeZone }).strict(),
]);

export async function scheduleRoutes(app: FastifyInstance, deps: Deps, guards: Guards) {
  async function view(orgId: string) {
    const row = await getSchedule(deps.db, orgId);
    if (!row) return { schedule: null, next: null };
    const schedule: Schedule =
      row.kind === "monthly"
        ? { kind: "monthly", dayOfMonth: row.dayOfMonth as number, timeZone: row.timeZone }
        : { kind: "biweekly", anchorDate: row.anchorDate as string, timeZone: row.timeZone };
    return {
      schedule: {
        kind: row.kind as "monthly" | "biweekly",
        dayOfMonth: row.dayOfMonth,
        anchorDate: row.anchorDate,
        timeZone: row.timeZone,
        paused: row.paused,
      },
      next: row.paused ? null : nextPayday(schedule, deps.clock()),
    };
  }

  app.get("/orgs/:orgId/payroll-schedule", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    await guards.requireMember(request, orgId);
    return view(orgId);
  });

  app.put("/orgs/:orgId/payroll-schedule", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const body = parse(putBody, request.body);
    await upsertSchedule(deps.db, orgId, {
      kind: body.kind,
      dayOfMonth: body.kind === "monthly" ? body.dayOfMonth : null,
      anchorDate: body.kind === "biweekly" ? body.anchorDate : null,
      timeZone: body.timeZone,
    });
    await writeAudit(deps.db, {
      orgId,
      actor: session.userId,
      action: "payroll_schedule.set",
      entity: "payroll_schedule",
      entityId: orgId,
      at: deps.clock(),
    });
    return view(orgId);
  });

  for (const [path, paused] of [
    ["pause", true],
    ["resume", false],
  ] as const) {
    app.post(`/orgs/:orgId/payroll-schedule/${path}`, async (request) => {
      const { orgId } = parse(orgParams, request.params);
      const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
      if (!(await setSchedulePaused(deps.db, orgId, paused))) {
        throw notFound();
      }
      await writeAudit(deps.db, {
        orgId,
        actor: session.userId,
        action: paused ? "payroll_schedule.pause" : "payroll_schedule.resume",
        entity: "payroll_schedule",
        entityId: orgId,
        at: deps.clock(),
      });
      return view(orgId);
    });
  }
  void AppError;
}
