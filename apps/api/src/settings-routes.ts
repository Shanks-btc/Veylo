// Organisation settings and display-only FX (slice W6). Settings are display and notification
// choices: the organisation's name, the currency its estimates show in, its time zone and which
// notices it wants. None of them is an input to money or to a signature.
import { DISPLAY_CURRENCY_CODES, isValidTimeZone } from "@veylo/core";
import { getOrganization, updateOrganizationSettings, writeAudit } from "@veylo/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, type Deps } from "./app.js";
import { notFound } from "./errors.js";
import type { Guards } from "./guards.js";

const orgParams = z.object({ orgId: z.uuid() });
const OWNER_ONLY = ["owner"] as const;

const notifications = z
  .object({
    payrollReady: z.boolean(),
    payoutSettled: z.boolean(),
    weeklySummary: z.boolean(),
  })
  .strict();

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    displayCurrency: z.enum(DISPLAY_CURRENCY_CODES as [string, ...string[]]).optional(),
    timeZone: z
      .string()
      .max(64)
      .refine((v) => isValidTimeZone(v))
      .optional(),
    notifications: notifications.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0);

export async function settingsRoutes(app: FastifyInstance, deps: Deps, guards: Guards) {
  const present = (org: NonNullable<Awaited<ReturnType<typeof getOrganization>>>) => ({
    name: org.name,
    treasuryAccountId: org.treasuryAccountId,
    displayCurrency: org.displayCurrency,
    timeZone: org.timeZone,
    notifications: org.notifications as {
      payrollReady: boolean;
      payoutSettled: boolean;
      weeklySummary: boolean;
    },
  });

  app.get("/orgs/:orgId/settings", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    await guards.requireMember(request, orgId);
    const org = await getOrganization(deps.db, orgId);
    if (!org) throw notFound();
    return present(org);
  });

  app.patch("/orgs/:orgId/settings", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const body = parse(patchBody, request.body);
    await deps.db.transaction(async (tx) => {
      await updateOrganizationSettings(tx, orgId, body);
      await writeAudit(tx, {
        orgId,
        actor: session.userId,
        action: "org.settings_update",
        entity: "organization",
        entityId: orgId,
        at: deps.clock(),
      });
    });
    const org = await getOrganization(deps.db, orgId);
    if (!org) throw notFound();
    return present(org);
  });

  // Display-only rates for estimates beside USD. Any signed-in person may read them; nothing here
  // can reach a payout. Unavailable is a normal answer, never an error.
  app.get("/fx", async (request) => {
    await guards.requireSession(request);
    return deps.fx ? deps.fx.rates() : { available: false as const };
  });
}
