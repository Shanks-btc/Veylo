import {
  addMoney,
  createFirstAttempt,
  createRetryAttempt,
  canRetry,
  checkNearSpend,
  DEFAULT_DEVIATION_PERCENT,
  formatFixed,
  getPayoutRoute,
  hasBlockingFlag,
  impliedRateText,
  InvalidTransitionError,
  isSafeMessageText,
  money,
  nearAmountForUsd,
  reviewFlags,
  transitionAttempt,
  transitionPayRun,
  USDC,
  type FailureReason,
  type PayoutAttempt,
  type PayoutRouteId,
  type PayRunStatus,
  type ReviewFlag,
} from "@veylo/core";
import {
  acknowledgeItem,
  clearAcknowledgements,
  deletePayRunItem,
  getActiveMembership,
  getPayRun,
  getPayRunItem,
  insertPayoutAttempt,
  insertPayRun,
  insertPayRunItem,
  lastPaidForContractor,
  listAttemptsForItems,
  listDestinations,
  listPayRunItems,
  listPayRuns,
  approvePayRun,
  activeEncumbranceTotal,
  setPayRunStatus,
  updatePayoutAttempt,
  updatePayRunItem,
  writeAudit,
  type Db,
} from "@veylo/db";
import { OneClickError, QuoteGuardError, type PayoutQuote } from "@veylo/intents";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, routeEnabled, type Deps } from "./app.js";
import { AppError, conflict, notFound } from "./errors.js";
import type { Guards } from "./guards.js";
import { createSessionAccess } from "./oneclick-session.js";
import { destinationPayable, loadPayeeContext, signedPayee } from "./payability.js";
import { createTreasuryLimiter } from "./rate-limit.js";

const OWNER_ONLY = ["owner"] as const;
/** Owners and preparers draft pay runs; only the owner reviews, approves, quotes and signs (D2). */
const WRITERS = ["owner", "preparer"] as const;

const runParams = z.object({ orgId: z.uuid(), payRunId: z.uuid() });
const itemParams = runParams.extend({ itemId: z.uuid() });
const orgParams = z.object({ orgId: z.uuid() });
const units = z.string().regex(/^[1-9]\d{0,18}$/);
const memo = z.string().trim().max(500).refine(isSafeMessageText);
const createBody = z
  .object({
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    mode: z.enum(["live", "simulated"]),
  })
  .strict();
const itemBody = z
  .object({ contractorId: z.uuid(), amount: units, memo: memo.optional() })
  .strict();
const patchItemBody = z
  .object({ amount: units.optional(), memo: memo.nullable().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0);
const quoteBody = z
  .object({ itemIds: z.array(z.uuid()).max(500).optional() })
  .strict()
  .optional();

type FeePreview = {
  amountIn: string;
  minAmountIn: string;
  amountOut: string;
  deliveryFee: string;
  /** minAmountIn minus the payout: the fee on the L9 basis. */
  fee: string;
  asOf: string;
  /** What the contractor receives (W6): NEAR is sized from the USD amount at quote time. */
  asset?: "USDC" | "NEAR";
  /** USDC per NEAR, from the quote's own amounts; null for a USDC payout. */
  rate?: string | null;
};

/**
 * Service-level approver check (L24). The database trigger stays as the backstop. Read inside the
 * approval transaction, so a demotion committed first is seen.
 */
export async function assertApproverIsActiveOwner(db: Db, orgId: string, userId: string) {
  const membership = await getActiveMembership(db, orgId, userId);
  if (membership?.role !== "owner") {
    throw new AppError(403, "APPROVER_NOT_ACTIVE_OWNER", "Only an active owner can approve");
  }
}

export async function payRunRoutes(app: FastifyInstance, deps: Deps, guards: Guards) {
  const limiter = createTreasuryLimiter({
    clock: deps.clock,
    perOrgPerHour: deps.config.treasuryLimitPerOrgPerHour ?? 60,
    perUserPerHour: deps.config.treasuryLimitPerUserPerHour ?? 30,
  });
  const session = createSessionAccess(deps);
  const deadlineMinutes = deps.config.payoutQuoteDeadlineMinutes ?? 15;
  const deviationPercent = deps.config.reviewDeviationPercent ?? DEFAULT_DEVIATION_PERCENT;

  async function requireRun(orgId: string, payRunId: string) {
    const run = await getPayRun(deps.db, orgId, payRunId);
    if (!run) throw notFound();
    return run;
  }
  const wrongStatus = (status: string) =>
    conflict("RUN_WRONG_STATUS", `Not allowed while the run is ${status}`);

  /** Every transition goes through the core state machine, then a guarded UPDATE. */
  async function transition(
    db: Db,
    run: { id: string; orgId: string; status: PayRunStatus; mode: "live" | "simulated" },
    to: PayRunStatus,
    actor: string,
  ) {
    try {
      transitionPayRun({ id: run.id, status: run.status, mode: run.mode }, to);
    } catch (err) {
      if (err instanceof InvalidTransitionError) throw wrongStatus(run.status);
      throw err;
    }
    if (!(await setPayRunStatus(db, run.orgId, run.id, run.status, to))) {
      throw conflict("RUN_CHANGED", "The run changed meanwhile. Reload and try again");
    }
    await writeAudit(db, {
      orgId: run.orgId,
      actor,
      action: `pay_run.${to.toLowerCase()}`,
      entity: "pay_run",
      entityId: run.id,
      at: deps.clock(),
    });
    return { ...run, status: to };
  }

  async function recomputeTotal(db: Db, orgId: string, payRunId: string) {
    const items = await listPayRunItems(db, orgId, payRunId);
    return items.reduce((sum, i) => sum + i.amountUsdc, 0n);
  }

  /** Flags and payability for one item, against the state right now. */
  async function assess(
    orgId: string,
    item: { contractorId: string; amountUsdc: bigint; payRunId: string },
  ) {
    const now = deps.clock();
    const ctx = await loadPayeeContext(deps.db, orgId, item.contractorId, now);
    const destinations = await listDestinations(deps.db, orgId, item.contractorId);
    const destination = destinations.find((d) => d.status === "active") ?? null;
    const payable = destination
      ? destinationPayable(ctx, destination)
      : { payable: false, payableReason: "no_active_destination" as const };
    const lastPaid = await lastPaidForContractor(deps.db, orgId, item.contractorId, item.payRunId);
    const replacedAnother = destinations.some((d) => d.status === "superseded");
    return { ctx, destination, payable, lastPaid, replacedAnother };
  }

  function flagsFor(
    a: Awaited<ReturnType<typeof assess>>,
    amount: bigint,
    feePreviewFailed: boolean,
  ): ReviewFlag[] {
    return reviewFlags({
      contractorStatus: a.ctx.contractorStatus,
      destination: a.destination
        ? {
            id: a.destination.id,
            enteredBy: a.destination.enteredBy,
            contractorConfirmedAt: a.destination.contractorConfirmedAt,
            createdAt: a.destination.createdAt,
            replacedAnother: a.replacedAnother,
          }
        : null,
      now: deps.clock(),
      payable: a.payable,
      lastPaid: a.lastPaid,
      amount,
      deviationPercent,
      feePreviewFailed,
    });
  }

  /**
   * The quote the treasury would sign for this item. Dry for previews and simulated runs.
   * `amount` is the item's USD amount (6 decimals). A USDC route delivers exactly that. A NEAR route
   * (W6) delivers an exact NEAR amount sized from 1Click's reference price (EXACT_OUTPUT), and the
   * treasury's spend is bounded against the USD amount: at least it, at most it plus the fee ceiling.
   */
  async function quoteFor(
    a: Awaited<ReturnType<typeof assess>>,
    amount: bigint,
    mode: "live" | "simulated",
  ): Promise<PayoutQuote> {
    const payee = signedPayee(a.ctx, (a.destination as { id: string }).id);
    if (!payee) throw new QuoteGuardError("no owner-signed payee for this destination");
    if (!routeEnabled(deps, payee.routeId))
      throw new QuoteGuardError("this payout route isn't enabled");
    const route = getPayoutRoute(payee.routeId as PayoutRouteId);
    let deliver = amount;
    if (route.asset === "NEAR") {
      const price = await deps.oneclickTreasury.referencePrice(route.assetId);
      deliver = nearAmountForUsd(amount, price);
    }
    const now = deps.clock();
    const quote = await deps.oneclickTreasury.createPayoutQuote({
      mode,
      treasuryAccountId: a.ctx.treasuryAccountId,
      refundTo: a.ctx.treasuryAccountId,
      payee: {
        recipient: payee.recipient,
        recipientType: payee.recipientType,
        destinationAsset: getPayoutRoute(payee.routeId as PayoutRouteId).assetId,
      },
      recipient: (a.destination as { address: string }).address,
      recipientType: getPayoutRoute((a.destination as { route: string }).route as PayoutRouteId)
        .recipientType,
      destinationAsset: (a.destination as { assetId: string }).assetId,
      amount: deliver.toString(),
      expectedAmount: deliver.toString(),
      now,
      deadline: new Date(now.getTime() + deadlineMinutes * 60_000),
      maxDeadlineMinutes: deadlineMinutes,
    });
    if (route.asset === "NEAR") {
      const spend = checkNearSpend(BigInt(quote.amountIn), amount);
      if (!spend.ok) throw new QuoteGuardError(spend.reason);
    }
    return quote;
  }

  /** What the review shows for a quote: the fee, and for NEAR the NEAR amount and the rate. */
  function previewOf(q: PayoutQuote, amount: bigint, routeId: string) {
    const route = getPayoutRoute(routeId as PayoutRouteId);
    const near = route.asset === "NEAR";
    return {
      amountIn: q.amountIn,
      minAmountIn: q.minAmountIn,
      amountOut: near ? formatFixed(BigInt(q.amountOut), 24) : q.amountOut,
      deliveryFee: q.withdrawFee,
      fee: (BigInt(q.minAmountIn) - amount).toString(),
      asOf: deps.clock().toISOString(),
      asset: route.asset,
      rate: near ? (impliedRateText(BigInt(q.amountIn), BigInt(q.amountOut)) ?? null) : null,
    };
  }

  async function review(log: FastifyBaseLogger, orgId: string, payRunId: string) {
    const items = await listPayRunItems(deps.db, orgId, payRunId);
    // The warnings are recomputed below, so earlier "I've checked this" ticks no longer cover them.
    await clearAcknowledgements(
      deps.db,
      orgId,
      items.map((i) => i.id),
    );
    for (const item of items) {
      const a = await assess(orgId, item);
      let feePreview: FeePreview | null = null;
      let feePreviewFailed = false;
      if (a.payable.payable) {
        try {
          const q = await quoteFor(a, item.amountUsdc, "simulated");
          feePreview = previewOf(q, item.amountUsdc, (a.destination as { route: string }).route);
        } catch (err) {
          log.warn({ err }, "fee preview failed");
          feePreviewFailed = true;
        }
      }
      await updatePayRunItem(deps.db, orgId, item.id, {
        destinationId: a.destination?.id ?? null,
        flags: flagsFor(a, item.amountUsdc, feePreviewFailed),
        feePreview,
      });
    }
  }

  function totals(items: { amountUsdc: bigint; feePreview: unknown }[]) {
    let payouts = money(USDC, 0n);
    let fees = money(USDC, 0n);
    let needed = money(USDC, 0n);
    for (const i of items) {
      payouts = addMoney(payouts, money(USDC, i.amountUsdc));
      const fp = i.feePreview as FeePreview | null;
      if (fp) {
        fees = addMoney(fees, money(USDC, BigInt(fp.fee)));
        // The signed debit is amountIn, which includes the slippage buffer: what must be covered.
        needed = addMoney(needed, money(USDC, BigInt(fp.amountIn)));
      }
    }
    return {
      payoutSum: payouts.units.toString(),
      feeSum: fees.units.toString(),
      grandTotal: needed.units.toString(),
    };
  }

  async function view(orgId: string, payRunId: string) {
    const run = await requireRun(orgId, payRunId);
    const items = await listPayRunItems(deps.db, orgId, payRunId);
    const attempts = await listAttemptsForItems(
      deps.db,
      orgId,
      items.map((i) => i.id),
    );
    const simulated = run.mode === "simulated";
    return {
      id: run.id,
      period: run.period,
      status: run.status,
      mode: run.mode,
      simulated,
      label: simulated ? "SIMULATED: no money moves; excluded from totals and evidence" : null,
      approvedBy: run.approvedBy,
      readyToSign:
        run.status === "Signing" ? (simulated ? "ready_to_sign_simulated" : "ready_to_sign") : null,
      totals: totals(items),
      items: items.map((i) => {
        const flags = (i.flags as ReviewFlag[]) ?? [];
        const latest = attempts
          .filter((a) => a.lineItemId === i.id)
          .sort((x, y) => y.attemptNo - x.attemptNo)[0];
        return {
          id: i.id,
          contractorId: i.contractorId,
          destinationId: i.destinationId,
          amount: i.amountUsdc.toString(),
          memo: (i.basis as { memo?: string }).memo ?? null,
          flags,
          blocked: hasBlockingFlag(flags),
          feePreview: i.feePreview,
          mode: i.mode,
          attempt: latest
            ? {
                attemptNo: latest.attemptNo,
                status: latest.status,
                failureReason: latest.failureReason,
                depositAddress: latest.depositAddress,
                requestedDeadline: latest.requestedDeadline,
                quoteDeadline: latest.deadline,
                amountIn: latest.amountIn?.toString() ?? null,
                minAmountIn: latest.minAmountIn?.toString() ?? null,
                mode: latest.mode,
              }
            : null,
        };
      }),
    };
  }

  const audit = (orgId: string, actor: string, action: string, entityId: string) =>
    writeAudit(deps.db, { orgId, actor, action, entity: "pay_run", entityId, at: deps.clock() });

  app.post("/orgs/:orgId/pay-runs", async (request, reply) => {
    const { orgId } = parse(orgParams, request.params);
    const { session: s } = await guards.requireRole(request, orgId, WRITERS);
    const body = parse(createBody, request.body);
    const run = await insertPayRun(deps.db, { orgId, period: body.period, mode: body.mode });
    await audit(orgId, s.userId, "pay_run.draft", run.id);
    return reply.status(201).send(await view(orgId, run.id));
  });

  app.get("/orgs/:orgId/pay-runs", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    await guards.requireMember(request, orgId);
    const runs = await listPayRuns(deps.db, orgId);
    return {
      payRuns: runs.map((r) => ({
        id: r.id,
        period: r.period,
        status: r.status,
        mode: r.mode,
        simulated: r.mode === "simulated",
        totalAmount: r.totalAmountUsdc.toString(),
        // A scheduled draft waiting for the owner (D1): the banner on the treasury home.
        scheduledFor: r.scheduledFor,
        readyForReview:
          r.readyForReviewAt !== null && ["Draft", "Prepared", "InReview"].includes(r.status),
      })),
    };
  });

  app.get("/orgs/:orgId/pay-runs/:payRunId", async (request) => {
    const { orgId, payRunId } = parse(runParams, request.params);
    await guards.requireMember(request, orgId);
    return view(orgId, payRunId);
  });

  app.post("/orgs/:orgId/pay-runs/:payRunId/items", async (request, reply) => {
    const { orgId, payRunId } = parse(runParams, request.params);
    const { session: s } = await guards.requireRole(request, orgId, WRITERS);
    const body = parse(itemBody, request.body);
    const run = await requireRun(orgId, payRunId);
    if (run.status !== "Draft") throw wrongStatus(run.status);
    const amount = money(USDC, BigInt(body.amount));
    const created = await deps.db.transaction(async (tx) => {
      const item = await insertPayRunItem(tx, {
        orgId,
        payRunId,
        contractorId: body.contractorId,
        amountUsdc: amount.units,
        basis: body.memo ? { memo: body.memo } : {},
        mode: run.mode,
      });
      if (!item) throw conflict("ITEM_EXISTS", "This contractor already has an item in this run");
      await setPayRunStatus(
        tx,
        orgId,
        payRunId,
        "Draft",
        "Draft",
        await recomputeTotal(tx, orgId, payRunId),
      );
      return item;
    });
    await audit(orgId, s.userId, "pay_run.item_add", created.id);
    return reply.status(201).send({ id: created.id });
  });

  app.patch("/orgs/:orgId/pay-runs/:payRunId/items/:itemId", async (request) => {
    const { orgId, payRunId, itemId } = parse(itemParams, request.params);
    const { session: s } = await guards.requireRole(request, orgId, WRITERS);
    const body = parse(patchItemBody, request.body);
    const run = await requireRun(orgId, payRunId);
    if (run.status !== "Draft") throw wrongStatus(run.status);
    const item = await getPayRunItem(deps.db, orgId, payRunId, itemId);
    if (!item) throw notFound();
    await deps.db.transaction(async (tx) => {
      const basis = { ...(item.basis as object) } as { memo?: string };
      if (body.memo === null) delete basis.memo;
      else if (body.memo !== undefined) basis.memo = body.memo;
      await updatePayRunItem(tx, orgId, itemId, {
        ...(body.amount ? { amountUsdc: money(USDC, BigInt(body.amount)).units } : {}),
        basis,
      });
      await setPayRunStatus(
        tx,
        orgId,
        payRunId,
        "Draft",
        "Draft",
        await recomputeTotal(tx, orgId, payRunId),
      );
    });
    await audit(orgId, s.userId, "pay_run.item_update", itemId);
    return { id: itemId };
  });

  app.delete("/orgs/:orgId/pay-runs/:payRunId/items/:itemId", async (request) => {
    const { orgId, payRunId, itemId } = parse(itemParams, request.params);
    const { session: s } = await guards.requireRole(request, orgId, WRITERS);
    const run = await requireRun(orgId, payRunId);
    if (run.status !== "Draft") throw wrongStatus(run.status);
    await deps.db.transaction(async (tx) => {
      if (!(await deletePayRunItem(tx, orgId, payRunId, itemId))) throw notFound();
      await setPayRunStatus(
        tx,
        orgId,
        payRunId,
        "Draft",
        "Draft",
        await recomputeTotal(tx, orgId, payRunId),
      );
    });
    await audit(orgId, s.userId, "pay_run.item_delete", itemId);
    return { ok: true };
  });

  /** The owner has read this item's warnings (D5). Signing a warned item needs this first. */
  app.post("/orgs/:orgId/pay-runs/:payRunId/items/:itemId/acknowledge", async (request) => {
    const { orgId, payRunId, itemId } = parse(
      z.object({ orgId: z.uuid(), payRunId: z.uuid(), itemId: z.uuid() }),
      request.params,
    );
    const { session: s } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const item = await getPayRunItem(deps.db, orgId, payRunId, itemId);
    if (!item) throw notFound();
    await acknowledgeItem(deps.db, orgId, itemId, s.userId);
    await audit(orgId, s.userId, "pay_run_item.acknowledge", itemId);
    return { ok: true as const };
  });

  app.post("/orgs/:orgId/pay-runs/:payRunId/prepare", async (request) => {
    const { orgId, payRunId } = parse(runParams, request.params);
    const { session: s } = await guards.requireRole(request, orgId, WRITERS);
    const run = await requireRun(orgId, payRunId);
    if (run.status !== "Draft") throw wrongStatus(run.status);
    if ((await listPayRunItems(deps.db, orgId, payRunId)).length === 0) {
      throw conflict("RUN_EMPTY", "Add at least one item first");
    }
    const prepared = await transition(deps.db, run, "Prepared", s.userId);
    await review(request.log, orgId, payRunId);
    await transition(deps.db, prepared, "InReview", s.userId);
    return view(orgId, payRunId);
  });

  /** Recomputes flags and fee previews while in review, for example after a payee is approved. */
  app.post("/orgs/:orgId/pay-runs/:payRunId/review", async (request) => {
    const { orgId, payRunId } = parse(runParams, request.params);
    await guards.requireRole(request, orgId, OWNER_ONLY);
    const run = await requireRun(orgId, payRunId);
    if (run.status !== "InReview") throw wrongStatus(run.status);
    await review(request.log, orgId, payRunId);
    return view(orgId, payRunId);
  });

  app.post("/orgs/:orgId/pay-runs/:payRunId/approve", async (request) => {
    const { orgId, payRunId } = parse(runParams, request.params);
    const { session: s } = await guards.requireRole(request, orgId, OWNER_ONLY);
    limiter.check("pay-run-approve", orgId, s.userId);
    const run = await requireRun(orgId, payRunId);
    if (run.status !== "InReview") throw wrongStatus(run.status);

    // Flags are recomputed now: a payee revoked since review blocks approval.
    const items = await listPayRunItems(deps.db, orgId, payRunId);
    const blocked: { itemId: string; flags: string[] }[] = [];
    for (const item of items) {
      const a = await assess(orgId, item);
      const flags = flagsFor(a, item.amountUsdc, item.feePreview === null);
      await updatePayRunItem(deps.db, orgId, item.id, { flags });
      if (hasBlockingFlag(flags)) {
        blocked.push({
          itemId: item.id,
          flags: flags.filter((f) => f.blocking).map((f) => f.code),
        });
      }
    }
    if (blocked.length > 0) {
      throw new AppError(409, "BLOCKING_FLAGS", "Some items can't be approved", { items: blocked });
    }

    let funds: object = { checked: false, reason: "simulated" };
    if (run.mode === "live") {
      const needed = BigInt(totals(items).grandTotal);
      const balance = await session.confidentialBalance(request.log, orgId);
      if (balance.status === "needs_session") {
        throw new AppError(
          409,
          "NEEDS_SESSION",
          "Sign in to 1Click from the treasury to read the confidential balance first",
        );
      }
      if (balance.status !== "ok") {
        throw new AppError(502, "BALANCE_UNAVAILABLE", "The confidential balance can't be read");
      }
      // Amounts in signed, unsettled payloads (L34) aren't available.
      const encumbered = await activeEncumbranceTotal(deps.db, orgId);
      const available = BigInt(balance.amount) - encumbered;
      if (available < needed) {
        throw new AppError(409, "INSUFFICIENT_FUNDS", "The treasury can't cover this run", {
          available: available.toString(),
          needed: needed.toString(),
          shortfall: (needed - available).toString(),
          encumbered: encumbered.toString(),
          asOf: deps.clock().toISOString(),
        });
      }
      funds = { checked: true, available: available.toString(), needed: needed.toString() };
    }

    await deps.db.transaction(async (tx) => {
      await assertApproverIsActiveOwner(tx, orgId, s.userId);
      try {
        transitionPayRun({ id: run.id, status: run.status, mode: run.mode }, "Quoting");
      } catch {
        throw wrongStatus(run.status);
      }
      if (!(await approvePayRun(tx, orgId, payRunId, s.userId, deps.clock()))) {
        throw conflict("RUN_CHANGED", "The run changed meanwhile. Reload and try again");
      }
      await writeAudit(tx, {
        orgId,
        actor: s.userId,
        action: "pay_run.quoting",
        entity: "pay_run",
        entityId: payRunId,
        at: deps.clock(),
      });
    });
    return { ...(await view(orgId, payRunId)), funds };
  });

  app.post("/orgs/:orgId/pay-runs/:payRunId/quote", async (request) => {
    const { orgId, payRunId } = parse(runParams, request.params);
    const { session: s } = await guards.requireRole(request, orgId, OWNER_ONLY);
    limiter.check("pay-run-quote", orgId, s.userId);
    const body = parse(quoteBody, request.body ?? undefined);
    const run = await requireRun(orgId, payRunId);
    if (run.status !== "Quoting") throw wrongStatus(run.status);

    const items = await listPayRunItems(deps.db, orgId, payRunId);
    const wanted = body?.itemIds ? new Set(body.itemIds) : undefined;
    for (const item of items) {
      if (wanted && !wanted.has(item.id)) continue;
      const rows = await listAttemptsForItems(deps.db, orgId, [item.id]);
      const attempts: PayoutAttempt[] = rows.map((r) => ({
        lineItemId: r.lineItemId,
        attemptNo: r.attemptNo,
        mode: r.mode,
        status: r.status,
        statusHistory: (r.statusHistory as { status: never; at: string }[]).map((h) => ({
          status: h.status,
          at: new Date(h.at),
        })),
        ...(r.reconciledAt ? { reconciledAt: r.reconciledAt } : {}),
      }));
      const latest = [...attempts].sort((x, y) => y.attemptNo - x.attemptNo)[0];
      // A retry (slice 5b) leaves a PLANNED attempt, which is quoted here as it is.
      const planned =
        latest?.status === "PLANNED"
          ? rows.find((r) => r.attemptNo === latest.attemptNo)
          : undefined;
      if (latest && !planned && !canRetry(latest)) continue;

      const now = deps.clock();
      let attempt = planned
        ? (latest as PayoutAttempt)
        : latest
          ? createRetryAttempt({ lineItemId: item.id, attempts, statusCheckedAt: now, at: now })
          : createFirstAttempt({
              lineItemId: item.id,
              mode: item.mode,
              at: now,
              existingAttempts: [],
            });
      // The PLANNED row claims the item: a second quote run for it fails on the unique index.
      const inserted =
        planned ??
        (await insertPayoutAttempt(deps.db, {
          orgId,
          lineItemId: item.id,
          attemptNo: attempt.attemptNo,
          status: "PLANNED",
          statusHistory: attempt.statusHistory,
          mode: item.mode,
        }));
      if (!inserted) continue;

      const fail = async (reason: FailureReason, detail: string) => {
        attempt = transitionAttempt(attempt, "FAILED", deps.clock(), reason);
        await updatePayoutAttempt(deps.db, orgId, inserted.id, {
          status: "FAILED",
          failureReason: reason,
          statusHistory: attempt.statusHistory,
          fees: { detail },
        });
      };

      // Gate B, server side, at call time: a payee revoked since approval stops here.
      const a = await assess(orgId, item);
      if (!a.payable.payable || a.destination?.id !== item.destinationId) {
        await fail("gate_blocked", a.payable.payableReason);
        continue;
      }
      try {
        const q = await quoteFor(a, item.amountUsdc, item.mode);
        attempt = transitionAttempt(attempt, "QUOTED", deps.clock());
        await updatePayoutAttempt(deps.db, orgId, inserted.id, {
          status: "QUOTED",
          statusHistory: attempt.statusHistory,
          quoteRequest: q.raw.quoteRequest,
          quote: q.raw,
          depositAddress: q.depositAddress ?? null,
          correlationId: q.correlationId,
          requestedDeadline: q.requestedDeadline,
          deadline: q.quoteDeadline ? new Date(q.quoteDeadline) : null,
          minAmountIn: BigInt(q.minAmountIn),
          amountIn: BigInt(q.amountIn),
          fees: {
            withdrawFee: q.withdrawFee,
            fee: (BigInt(q.minAmountIn) - item.amountUsdc).toString(),
            // For a NEAR payout the delivered amount and the rate, from the signed quote (W6).
            ...(getPayoutRoute((a.destination as { route: string }).route as PayoutRouteId)
              .asset === "NEAR"
              ? {
                  asset: "NEAR",
                  deliveredYocto: q.amountOut,
                  rate: impliedRateText(BigInt(q.amountIn), BigInt(q.amountOut)),
                }
              : {}),
          },
        });
      } catch (err) {
        if (err instanceof QuoteGuardError) await fail("quote_rejected", err.message);
        else if (err instanceof OneClickError) {
          await fail(err.kind === "rejected" ? "quote_rejected" : "unknown", err.detail);
        } else throw err;
      }
    }

    // All latest attempts quoted: the run is ready to sign (5b), or ready-to-sign-simulated.
    const after = await listAttemptsForItems(
      deps.db,
      orgId,
      items.map((i) => i.id),
    );
    const allQuoted = items.every((i) => {
      const latest = after
        .filter((x) => x.lineItemId === i.id)
        .sort((x, y) => y.attemptNo - x.attemptNo)[0];
      return latest?.status === "QUOTED";
    });
    if (allQuoted) await transition(deps.db, run, "Signing", s.userId);
    return view(orgId, payRunId);
  });
}
