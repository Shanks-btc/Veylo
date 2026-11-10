import { validateAddress } from "@veylo/chains";
import {
  addressHygieneWarnings,
  computeFee,
  isSafeMessageText,
  payeeStatus,
  getPayoutRoute,
  money,
  PAYOUT_ROUTE_IDS,
  USDC,
  type PayoutRoute,
} from "@veylo/core";
import {
  archiveContractor,
  getContractor,
  getCurrentHead,
  listApprovalsForContractor,
  getDestination,
  getOrganization,
  insertContractor,
  insertDestination,
  listContractors,
  listDestinations,
  promoteDestination,
  recordDestinationCheck,
  updateContractor,
  writeAudit,
  type Db,
} from "@veylo/db";
import { acceptanceQuote } from "@veylo/intents";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, type Deps } from "./app.js";
import { AppError, conflict, notFound } from "./errors.js";
import type { Guards } from "./guards.js";
import { destinationPayable, loadPayeeContext, type PayeeContext } from "./payability.js";

const OWNER_ONLY = ["owner"] as const;
const QUOTE_DEADLINE_MS = 10 * 60 * 1000;

/** A rate is USDC smallest units, as text, so it can't become a float in JSON. */
const terms = z
  .object({
    kind: z.enum(["hourly", "fixed"]),
    rate: z.string().regex(/^[1-9]\d{0,18}$/),
    schedule: z.enum(["weekly", "biweekly", "monthly"]),
  })
  .strict();
// The name is shown in a message the owner signs, so it can't hold a line break or hidden text.
const name = z.string().trim().min(1).max(200).refine(isSafeMessageText);
const email = z.email().max(320);

const createContractorBody = z.object({ name, email: email.optional(), terms }).strict();
const patchContractorBody = z
  .object({ name: name.optional(), email: email.nullable().optional(), terms: terms.optional() })
  .strict()
  .refine((body) => Object.keys(body).length > 0);
// `address` and `route` are all a destination takes. An address can never be patched.
const createDestinationBody = z
  .object({ route: z.enum(PAYOUT_ROUTE_IDS), address: z.string().max(128) })
  .strict();

const orgParams = z.object({ orgId: z.uuid() });
const contractorParams = z.object({ orgId: z.uuid(), contractorId: z.uuid() });
const destinationParams = contractorParams.extend({ destinationId: z.uuid() });

type Row = Awaited<ReturnType<typeof listDestinations>>[number];

export async function contractorRoutes(app: FastifyInstance, deps: Deps, guards: Guards) {
  async function requireContractor(db: Db, orgId: string, contractorId: string) {
    const contractor = await getContractor(db, orgId, contractorId);
    if (!contractor) throw notFound();
    return contractor;
  }
  function requireNotArchived(contractor: { status: string }) {
    if (contractor.status === "archived") {
      throw conflict("CONTRACTOR_ARCHIVED", "This contractor is archived");
    }
  }

  /** Dry only (slice 3): checks that 1Click accepts the address and previews the fee (rule 1, D6). */
  async function runCheck(orgId: string, route: PayoutRoute, recipient: string) {
    const org = await getOrganization(deps.db, orgId);
    if (!org) throw notFound();
    const result = await deps.oneclick.dryQuote(
      acceptanceQuote({
        route,
        recipient,
        treasuryAccountId: org.treasuryAccountId,
        deadline: new Date(deps.clock().getTime() + QUOTE_DEADLINE_MS),
      }),
    );
    if (result.outcome !== "accepted") {
      return { checkStatus: result.outcome, checkReason: result.reason, feePreview: null };
    }
    try {
      const fee = computeFee({
        mode: "simulated",
        amountIn: money(USDC, BigInt(result.amountIn)),
        minAmountIn: money(USDC, BigInt(result.minAmountIn)),
        amountOut: money(USDC, BigInt(result.amountOut)),
        withdrawFee: money(USDC, BigInt(result.withdrawFee)),
      });
      return {
        checkStatus: "accepted" as const,
        checkReason: null,
        feePreview: {
          amountOut: result.amountOut,
          amountIn: fee.amountIn.units.toString(),
          minAmountIn: fee.minAmountIn.units.toString(),
          impliedFee: fee.impliedFee.units.toString(),
          impliedFeeBps: fee.impliedFeeBps,
          deliveryFee: fee.deliveryFee.units.toString(),
        },
      };
    } catch {
      return {
        checkStatus: "check_failed" as const,
        checkReason: "1Click sent an inconsistent quote",
        feePreview: null,
      };
    }
  }

  const payeeContext = (orgId: string, contractorId: string, now: Date) =>
    loadPayeeContext(deps.db, orgId, contractorId, now);

  function present(row: Row, all: readonly Row[], ctx: PayeeContext) {
    const status = destinationPayable(ctx, row);
    return {
      id: row.id,
      contractorId: row.contractorId,
      route: row.route,
      payoutMode: row.payoutMode,
      chain: row.chain,
      assetId: row.assetId,
      address: row.address,
      status: row.status,
      supersededAt: row.supersededAt,
      check: { status: row.checkStatus, reason: row.checkReason, checkedAt: row.checkedAt },
      feePreview: row.feePreview,
      receivedPublicPayout: row.receivedPublicPayout,
      enteredBy: row.enteredBy,
      contractorConfirmedAt: row.contractorConfirmedAt,
      ...status,
      warnings: addressHygieneWarnings({ destinations: all }),
    };
  }

  /** Applies an accepted check: this destination becomes active, and every other one is superseded. */
  async function promote(tx: Db, orgId: string, actor: string, row: Row, now: Date) {
    const superseded = await promoteDestination(
      tx,
      orgId,
      row.contractorId,
      row.id,
      row.payoutMode,
      now,
    );
    for (const id of superseded) {
      await writeAudit(tx, {
        orgId,
        actor,
        action: "destination.supersede",
        entity: "payout_destination",
        entityId: id,
        at: now,
      });
    }
  }

  app.post("/orgs/:orgId/contractors", async (request, reply) => {
    const { orgId } = parse(orgParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const body = parse(createContractorBody, request.body);
    const contractor = await deps.db.transaction(async (tx) => {
      const created = await insertContractor(tx, orgId, { ...body, email: body.email ?? null });
      await writeAudit(tx, {
        orgId,
        actor: session.userId,
        action: "contractor.create",
        entity: "contractor",
        entityId: created.id,
        at: deps.clock(),
      });
      return created;
    });
    return reply.status(201).send(contractor);
  });

  app.get("/orgs/:orgId/contractors", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    await guards.requireMember(request, orgId);
    return { contractors: await listContractors(deps.db, orgId) };
  });

  app.get("/orgs/:orgId/contractors/:contractorId", async (request) => {
    const { orgId, contractorId } = parse(contractorParams, request.params);
    await guards.requireMember(request, orgId);
    return requireContractor(deps.db, orgId, contractorId);
  });

  app.patch("/orgs/:orgId/contractors/:contractorId", async (request) => {
    const { orgId, contractorId } = parse(contractorParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const body = parse(patchContractorBody, request.body);
    requireNotArchived(await requireContractor(deps.db, orgId, contractorId));
    return deps.db.transaction(async (tx) => {
      const updated = await updateContractor(tx, orgId, contractorId, body);
      await writeAudit(tx, {
        orgId,
        actor: session.userId,
        action: "contractor.update",
        entity: "contractor",
        entityId: contractorId,
        at: deps.clock(),
      });
      return updated;
    });
  });

  app.post("/orgs/:orgId/contractors/:contractorId/archive", async (request) => {
    const { orgId, contractorId } = parse(contractorParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    requireNotArchived(await requireContractor(deps.db, orgId, contractorId));
    return deps.db.transaction(async (tx) => {
      const archived = await archiveContractor(tx, orgId, contractorId);
      await writeAudit(tx, {
        orgId,
        actor: session.userId,
        action: "contractor.archive",
        entity: "contractor",
        entityId: contractorId,
        at: deps.clock(),
      });
      return archived;
    });
  });

  app.get("/orgs/:orgId/contractors/:contractorId/destinations", async (request) => {
    const { orgId, contractorId } = parse(contractorParams, request.params);
    await guards.requireMember(request, orgId);
    await requireContractor(deps.db, orgId, contractorId);
    const rows = await listDestinations(deps.db, orgId, contractorId);
    const ctx = await payeeContext(orgId, contractorId, deps.clock());
    return { destinations: rows.map((row) => present(row, rows, ctx)) };
  });

  app.post("/orgs/:orgId/contractors/:contractorId/destinations", async (request, reply) => {
    const { orgId, contractorId } = parse(contractorParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const body = parse(createDestinationBody, request.body);
    requireNotArchived(await requireContractor(deps.db, orgId, contractorId));

    const route = getPayoutRoute(body.route);
    const address = validateAddress(route.addressKind, body.address);
    if (!address.ok) throw new AppError(400, "ADDRESS_INVALID", address.message);

    // Outside the transaction: never hold a database connection across a network call.
    const check = await runCheck(orgId, route, address.normalized);
    const now = deps.clock();
    const id = await deps.db.transaction(async (tx) => {
      const row = await insertDestination(tx, orgId, contractorId, {
        route: route.id,
        chain: route.chain,
        assetId: route.assetId,
        payoutMode: route.payoutMode,
        address: address.normalized,
        ...check,
        checkedAt: now,
      });
      await writeAudit(tx, {
        orgId,
        actor: session.userId,
        action: "destination.create",
        entity: "payout_destination",
        entityId: row.id,
        at: now,
      });
      if (check.checkStatus === "accepted") await promote(tx, orgId, session.userId, row, now);
      return row.id;
    });
    const rows = await listDestinations(deps.db, orgId, contractorId);
    const ctx = await payeeContext(orgId, contractorId, deps.clock());
    return reply.status(201).send(present(rows.find((r) => r.id === id) as Row, rows, ctx));
  });

  app.post(
    "/orgs/:orgId/contractors/:contractorId/destinations/:destinationId/recheck",
    async (request) => {
      const { orgId, contractorId, destinationId } = parse(destinationParams, request.params);
      const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
      requireNotArchived(await requireContractor(deps.db, orgId, contractorId));
      const current = await getDestination(deps.db, orgId, contractorId, destinationId);
      if (!current) throw notFound();
      const notRetryable = () =>
        conflict("NOT_RETRYABLE", "Only a failed check or an unavailable route can be rechecked");
      if (
        (current.checkStatus !== "check_failed" && current.checkStatus !== "route_unavailable") ||
        current.status !== "candidate"
      ) {
        throw notRetryable();
      }

      const route = getPayoutRoute(current.route as never);
      const check = await runCheck(orgId, route, current.address);
      const now = deps.clock();
      await deps.db.transaction(async (tx) => {
        // Only one recheck can win, and a destination superseded meanwhile stays superseded.
        const row = await recordDestinationCheck(tx, orgId, contractorId, destinationId, {
          ...check,
          checkedAt: now,
        });
        if (!row) throw notRetryable();
        await writeAudit(tx, {
          orgId,
          actor: session.userId,
          action: "destination.recheck",
          entity: "payout_destination",
          entityId: destinationId,
          at: now,
        });
        if (check.checkStatus === "accepted") await promote(tx, orgId, session.userId, row, now);
      });
      const rows = await listDestinations(deps.db, orgId, contractorId);
      const ctx = await payeeContext(orgId, contractorId, deps.clock());
      return present(rows.find((r) => r.id === destinationId) as Row, rows, ctx);
    },
  );
}
