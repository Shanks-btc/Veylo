// The contractor portal (slice W5, D3): a contractor signs in with their NEAR wallet, through an
// invite the owner made, and sees their own payslips and payout address. They are not a member of
// the organisation: every portal route is "a signed-in user, and the contractor linked to them".
//
// Changing an address is a request with a 24-hour cooling period. Until the owner applies it, the
// old address and its signed approval keep working. The owner can't apply it earlier, and sees it
// listed with the time it becomes possible.
import { createHash } from "node:crypto";
import {
  ADDRESS_COOLING_MS,
  DISPLAY_CURRENCY_CODES,
  getPayoutRoute,
  PAYOUT_ROUTE_IDS,
  type PayoutRouteId,
} from "@veylo/core";
import { validateAddress } from "@veylo/chains";
import {
  acceptInvite,
  createInvite,
  getContractor,
  getContractorForUser,
  insertAddressChange,
  ledgerAttempts,
  listAddressChanges,
  listContractorsForUser,
  listDestinations,
  markAddressChangeApplied,
  updateContractor,
  writeAudit,
} from "@veylo/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, routeEnabled, type Deps } from "./app.js";
import { AppError, conflict, notFound, routeDisabled } from "./errors.js";
import type { Guards } from "./guards.js";
import { portalSessionRoutes } from "./portal-session-routes.js";
import { presentAttempt, type AttemptRow } from "./reporting-routes.js";

const OWNER_ONLY = ["owner"] as const;
const WRITERS = ["owner", "preparer"] as const;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");
const orgContractor = z.object({ orgId: z.uuid(), contractorId: z.uuid() });
const portalContractor = z.object({ contractorId: z.uuid() });
const displayCurrencyBody = z
  .object({ displayCurrency: z.enum(DISPLAY_CURRENCY_CODES as [string, ...string[]]).nullable() })
  .strict();
const acceptBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const changeBody = z
  .object({ route: z.enum(PAYOUT_ROUTE_IDS), address: z.string().max(128) })
  .strict();

export async function portalRoutes(
  app: FastifyInstance,
  deps: Deps,
  guards: Guards,
  /** Creates a destination for a contractor exactly as the owner's own "add address" does. */
  addDestination: (
    orgId: string,
    contractorId: string,
    actor: string,
    routeId: string,
    address: string,
    createdAt?: Date,
  ) => Promise<string>,
) {
  // ---- The owner's side ----

  /** An invite link for a contractor. The token is shown once; only its hash is kept. */
  app.post("/orgs/:orgId/contractors/:contractorId/invites", async (request, reply) => {
    const { orgId, contractorId } = parse(orgContractor, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const contractor = await getContractor(deps.db, orgId, contractorId);
    if (!contractor || contractor.status !== "active") throw notFound();
    const token = Buffer.from(deps.random(32)).toString("base64url");
    const expiresAt = new Date(deps.clock().getTime() + INVITE_TTL_MS);
    await createInvite(deps.db, {
      orgId,
      contractorId,
      tokenHash: sha256Hex(token),
      expiresAt,
      createdBy: session.userId,
    });
    await writeAudit(deps.db, {
      orgId,
      actor: session.userId,
      action: "contractor.invite",
      entity: "contractor",
      entityId: contractorId,
      at: deps.clock(),
    });
    return reply.status(201).send({ token, expiresAt });
  });

  const presentChange = (c: Awaited<ReturnType<typeof listAddressChanges>>[number], now: Date) => ({
    id: c.id,
    route: c.route,
    address: c.address,
    requestedAt: c.requestedAt,
    appliesAfter: c.appliesAfter,
    applied: c.appliedAt !== null,
    canApply: c.appliedAt === null && c.cancelledAt === null && c.appliesAfter <= now,
  });

  app.get("/orgs/:orgId/contractors/:contractorId/address-changes", async (request) => {
    const { orgId, contractorId } = parse(orgContractor, request.params);
    await guards.requireRole(request, orgId, WRITERS);
    const now = deps.clock();
    const rows = await listAddressChanges(deps.db, orgId, contractorId);
    return {
      changes: rows.filter((c) => c.cancelledAt === null).map((c) => presentChange(c, now)),
    };
  });

  /** Applies a contractor's request, but only after its cooling period. */
  app.post(
    "/orgs/:orgId/contractors/:contractorId/address-changes/:requestId/apply",
    async (request) => {
      const { orgId, contractorId, requestId } = parse(
        orgContractor.extend({ requestId: z.uuid() }),
        request.params,
      );
      const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
      const change = (await listAddressChanges(deps.db, orgId, contractorId)).find(
        (c) => c.id === requestId,
      );
      if (!change || change.cancelledAt !== null) throw notFound();
      if (change.appliedAt !== null)
        throw conflict("ALREADY_APPLIED", "This change was already applied");
      const now = deps.clock();
      if (change.appliesAfter > now) {
        throw conflict(
          "COOLING_PERIOD",
          `This address can't be applied before ${change.appliesAfter.toISOString()}: new addresses wait 24 hours`,
        );
      }
      // Claim the request first, so two clicks make one destination.
      if (!(await markAddressChangeApplied(deps.db, orgId, requestId, now)))
        throw conflict("ALREADY_APPLIED", "This change was already applied");
      // The address ages from the contractor's request, so the pay run's own 24-hour rule doesn't
      // make it wait a second time.
      await addDestination(
        orgId,
        contractorId,
        session.userId,
        change.route,
        change.address,
        change.requestedAt,
      );
      return {
        changes: (await listAddressChanges(deps.db, orgId, contractorId)).map((c) =>
          presentChange(c, now),
        ),
      };
    },
  );

  // ---- The contractor's side ----

  app.post("/portal/invites/accept", async (request) => {
    const session = await guards.requireSession(request);
    const { token } = parse(acceptBody, request.body);
    const result = await acceptInvite(deps.db, sha256Hex(token), session.userId, deps.clock());
    if (!result.ok) {
      throw result.reason === "claimed"
        ? conflict("INVITE_CLAIMED", "Someone has already joined with this contractor")
        : new AppError(400, "INVITE_INVALID", "This invite link isn't valid any more");
    }
    await writeAudit(deps.db, {
      orgId: result.orgId,
      actor: session.userId,
      action: "contractor.invite_accepted",
      entity: "contractor",
      entityId: result.contractorId,
      at: deps.clock(),
    });
    return { orgId: result.orgId, contractorId: result.contractorId };
  });

  async function own(request: Parameters<Guards["requireSession"]>[0], contractorId: string) {
    const session = await guards.requireSession(request);
    const contractor = await getContractorForUser(deps.db, contractorId, session.userId);
    if (!contractor) throw notFound(); // Not theirs, or not a contractor: nothing is revealed.
    return { session, contractor };
  }

  app.get("/portal/me", async (request) => {
    const session = await guards.requireSession(request);
    return { contractors: await listContractorsForUser(deps.db, session.userId) };
  });

  app.patch("/portal/contractors/:contractorId/display-currency", async (request) => {
    const { contractorId } = parse(portalContractor, request.params);
    const { contractor } = await own(request, contractorId);
    const body = parse(displayCurrencyBody, request.body);
    await updateContractor(deps.db, contractor.orgId, contractor.id, {
      displayCurrency: body.displayCurrency,
    });
    return { displayCurrency: body.displayCurrency };
  });

  app.get("/portal/contractors/:contractorId/payslips", async (request) => {
    const { contractorId } = parse(portalContractor, request.params);
    const { contractor } = await own(request, contractorId);
    const rows = (await ledgerAttempts(deps.db, contractor.orgId)).filter(
      (r) => r.contractorId === contractor.id,
    ) as AttemptRow[];
    const byItem = new Map<string, AttemptRow[]>();
    for (const r of rows) byItem.set(r.lineItemId, [...(byItem.get(r.lineItemId) ?? []), r]);
    const payslips = [...byItem.values()].map((group) => {
      const chosen =
        group.find((r) => r.status === "SUCCESS") ??
        group.sort((a, b) => b.attemptNo - a.attemptNo)[0];
      const p = presentAttempt(chosen as AttemptRow);
      return {
        itemId: p.itemId,
        payRunId: p.payRunId,
        period: p.period,
        amount: p.amount,
        currency: p.currency,
        paidCurrency: p.paidCurrency,
        paidAmount: p.paidAmount,
        rate: p.rate,
        quoteAsOf: p.quoteAsOf,
        route: p.routeLabel,
        status: p.status,
        at: p.at,
      };
    });
    return { payslips: payslips.sort((a, b) => b.at.localeCompare(a.at)) };
  });

  app.get("/portal/contractors/:contractorId/destinations", async (request) => {
    const { contractorId } = parse(portalContractor, request.params);
    const { contractor } = await own(request, contractorId);
    const rows = await listDestinations(deps.db, contractor.orgId, contractor.id);
    return {
      destinations: rows.map((d) => ({
        id: d.id,
        route: d.route,
        address: d.address,
        status: d.status,
        checkStatus: d.checkStatus,
      })),
    };
  });

  app.get("/portal/contractors/:contractorId/address-changes", async (request) => {
    const { contractorId } = parse(portalContractor, request.params);
    const { contractor } = await own(request, contractorId);
    const now = deps.clock();
    const rows = await listAddressChanges(deps.db, contractor.orgId, contractor.id);
    return {
      changes: rows.filter((c) => c.cancelledAt === null).map((c) => presentChange(c, now)),
    };
  });

  /** Asks to change the payout address. Nothing changes for 24 hours, and then only the owner can. */
  app.post("/portal/contractors/:contractorId/address-change", async (request, reply) => {
    const { contractorId } = parse(portalContractor, request.params);
    const { session, contractor } = await own(request, contractorId);
    const body = parse(changeBody, request.body);
    if (!routeEnabled(deps, body.route)) throw routeDisabled();
    const route = getPayoutRoute(body.route as PayoutRouteId);
    const address = validateAddress(route.addressKind, body.address);
    if (!address.ok) throw new AppError(400, "ADDRESS_INVALID", address.message);
    // Fail closed: a NEAR account we can't find, or can't look up, isn't accepted.
    if (route.addressKind === "near") {
      let exists = false;
      try {
        exists = await deps.rpc.viewAccount(address.normalized);
      } catch {
        throw new AppError(
          503,
          "NEAR_UNAVAILABLE",
          "Couldn't check that account right now. Try again",
        );
      }
      if (!exists)
        throw new AppError(400, "ACCOUNT_NOT_FOUND", "That account doesn't exist on NEAR");
    }
    const now = deps.clock();
    const created = await insertAddressChange(deps.db, {
      orgId: contractor.orgId,
      contractorId: contractor.id,
      route: route.id,
      address: address.normalized,
      requestedBy: session.userId,
      requestedAt: now,
      appliesAfter: new Date(now.getTime() + ADDRESS_COOLING_MS),
    });
    await writeAudit(deps.db, {
      orgId: contractor.orgId,
      actor: session.userId,
      action: "contractor.address_change_requested",
      entity: "contractor",
      entityId: contractor.id,
      at: now,
    });
    return reply.status(201).send(presentChange(created, now));
  });

  // The contractor's own private balance and the session that reads it (slice W6).
  await portalSessionRoutes(app, deps, own);
}
