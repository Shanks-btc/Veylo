// Ledger, payslips, CSV export and the audit view (slice 6). Read-only. Simulated records are shown
// only when asked for, always labelled, and never exported (L7).
import { intentsExplorerUrl, txExplorerUrl, type ExplorerChain } from "@veylo/chains";
import { formatFixed, getPayoutRoute, toCsv, type PayoutRouteId } from "@veylo/core";
import {
  ledgerAttempts,
  ledgerAttemptsPage,
  ledgerTreasuryEventsPage,
  listAuditPage,
} from "@veylo/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, type Deps } from "./app.js";
import { invalidRequest, notFound } from "./errors.js";
import type { Guards } from "./guards.js";

const READERS = ["owner", "accountant"] as const;
const SIMULATED_LABEL = "SIMULATED: no money moved";

const orgParams = z.object({ orgId: z.uuid() });
const payslipParams = z.object({ orgId: z.uuid(), payRunId: z.uuid(), itemId: z.uuid() });
const cursor = z.string().max(200).optional();
const limit = z.coerce.number().int().min(1).max(200).default(50);
const ledgerQuery = z
  .object({
    period: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    contractorId: z.uuid().optional(),
    status: z
      .string()
      .regex(/^[A-Za-z_]{1,32}$/)
      .optional(),
    mode: z.enum(["live", "simulated", "all"]).default("live"),
    cursor,
    limit,
  })
  .strict();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const csvQuery = z.object({ from: day, to: day }).strict();
const auditQuery = z
  .object({
    action: z
      .string()
      .regex(/^[a-z_.]{1,64}\*?$/)
      .optional(),
    cursor,
    limit,
  })
  .strict();

// Keyset cursors (L37): the last row's (microseconds since the epoch, id). The database does the
// filtering, ordering and limiting; nothing is paged in memory.
type Cursor = { us: bigint; id: string };
const encodeCursor = (c: Cursor) =>
  Buffer.from(JSON.stringify({ us: c.us.toString(), id: c.id })).toString("base64url");
function decodeCursor(text: string | undefined): Cursor | undefined {
  if (!text) return undefined;
  try {
    const c = JSON.parse(Buffer.from(text, "base64url").toString()) as { us: unknown; id: unknown };
    if (typeof c.us !== "string" || !/^\d{1,20}$/.test(c.us)) throw new Error();
    if (typeof c.id !== "string" || !z.uuid().safeParse(c.id).success) throw new Error();
    return { us: BigInt(c.us), id: c.id.toLowerCase() };
  } catch {
    throw invalidRequest();
  }
}
const keyset = (after: Cursor | undefined, n: number) => ({
  afterUs: after?.us,
  afterId: after?.id,
  limit: n + 1,
});
/** Newest first on (at, id); ids are lowercase UUIDs, so string order is Postgres's uuid order. */
const newestFirst = (a: { atUs: bigint; id: string }, b: { atUs: bigint; id: string }) =>
  a.atUs === b.atUs ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.atUs < b.atUs ? 1 : -1;
function pageOf<T extends { atUs: bigint; id: string }>(rows: T[], n: number) {
  const items = rows.slice(0, n);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > n && last ? encodeCursor({ us: last.atUs, id: last.id }) : null,
  };
}

type AttemptRow = Awaited<ReturnType<typeof ledgerAttempts>>[number];

/** Full chain names for people and the CSV export, never internal codes (L37). */
const CHAIN_NAMES: Record<string, string> = {
  base: "Base",
  arb: "Arbitrum",
  sol: "Solana",
  near: "NEAR",
  bsc: "BNB Smart Chain",
};
const chainName = (code: string | null | undefined) => (code ? (CHAIN_NAMES[code] ?? code) : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
const usdc = (units: bigint | null | undefined) =>
  units === null || units === undefined ? null : formatFixed(units, 6);

function routeOf(row: AttemptRow) {
  return row.route ? getPayoutRoute(row.route as PayoutRouteId) : undefined;
}

/** Everything about one payout attempt that a person or an auditor could ask for. */
function presentAttempt(row: AttemptRow) {
  const route = routeOf(row);
  const fees = (row.fees ?? {}) as { withdrawFee?: string; fee?: string };
  const near = strings(row.nearTxHashes);
  const quoteTimestamp = (row.quote as { timestamp?: string } | null)?.timestamp ?? null;
  const simulated = row.mode === "simulated";
  return {
    kind: "payout" as const,
    id: row.id,
    at: (row.terminalAt ?? row.createdAt).toISOString(),
    mode: row.mode,
    simulated,
    label: simulated ? SIMULATED_LABEL : null,
    payRunId: row.payRunId,
    period: row.period,
    itemId: row.lineItemId,
    contractor: { id: row.contractorId, name: row.contractorName },
    attemptNo: row.attemptNo,
    status: row.status,
    failureReason: row.failureReason,
    // Only what was observed (L18).
    statusHistory: row.statusHistory,
    amount: usdc(row.amountUsdc),
    currency: "USDC",
    route: route?.id ?? null,
    routeLabel: route?.label ?? null,
    chain: route?.chain ?? null,
    recipient: row.recipient,
    amountIn: usdc(row.amountIn),
    minAmountIn: usdc(row.minAmountIn),
    deliveryFee: fees.withdrawFee ? usdc(BigInt(fees.withdrawFee)) : null,
    totalFee: fees.fee ? usdc(BigInt(fees.fee)) : null,
    quoteAsOf: quoteTimestamp,
    refundedAmount: usdc(row.refundedAmount),
    reconciled: row.reconciledAt !== null,
    reconciledAt: row.reconciledAt,
    balanceUnconfirmed: row.balanceUnconfirmed,
    // Every hash (rule 2).
    hashes: {
      depositAddress: row.depositAddress,
      correlationId: row.correlationId,
      intentHash: row.intentHash,
      settlementIntentHashes: strings(row.settlementIntentHashes),
      nearTxHashes: near,
      destinationTxHash: row.destinationTxHash,
    },
    links: {
      intentsExplorer:
        row.depositAddress && !simulated ? (intentsExplorerUrl(row.depositAddress) ?? null) : null,
      nearTxs: near.map((h) => txExplorerUrl("near", h)).filter(Boolean),
      destinationTx:
        row.destinationTxHash && route && route.chain !== "near"
          ? (txExplorerUrl(route.chain as ExplorerChain, row.destinationTxHash) ?? null)
          : null,
    },
  };
}

export async function reportingRoutes(app: FastifyInstance, deps: Deps, guards: Guards) {
  app.get("/orgs/:orgId/ledger", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    await guards.requireRole(request, orgId, READERS);
    const q = parse(ledgerQuery, request.query);
    const after = decodeCursor(q.cursor);
    const filter = {
      mode: q.mode === "all" ? undefined : q.mode,
      period: q.period,
      contractorId: q.contractorId,
      status: q.status,
    };
    // Two keyset queries, each at most limit + 1 rows past the cursor; the newest limit + 1 of their
    // union are exactly the next rows of the merged ledger.
    const attempts = (await ledgerAttemptsPage(deps.db, orgId, filter, keyset(after, q.limit))).map(
      (r) => ({ ...presentAttempt(r), atUs: r.atUs }),
    );
    const events = q.contractorId
      ? []
      : (await ledgerTreasuryEventsPage(deps.db, orgId, filter, keyset(after, q.limit))).map(
          (e) => {
            const body = (e.lastStatus ?? {}) as { swapDetails?: Record<string, unknown> };
            const near = strings(body.swapDetails?.nearTxHashes);
            return {
              kind: "treasury_event" as const,
              atUs: e.atUs,
              id: e.id,
              at: e.createdAt.toISOString(),
              type: e.type,
              mode: e.mode,
              simulated: e.mode === "simulated",
              label: e.mode === "simulated" ? SIMULATED_LABEL : null,
              status: e.status,
              statusHistory: e.statusHistory,
              originAsset: e.originAsset,
              originAmount: e.originAmount,
              destinationAmount: usdc(e.destinationAmount),
              hashes: {
                depositAddress: e.depositAddress,
                correlationId: e.correlationId,
                intentHash: e.intentHash,
                nearTxHashes: near,
              },
              links: {
                intentsExplorer: intentsExplorerUrl(e.depositAddress) ?? null,
                nearTxs: near.map((h) => txExplorerUrl("near", h)).filter(Boolean),
              },
            };
          },
        );
    const merged = [...attempts, ...events].sort(newestFirst);
    const { items, nextCursor } = pageOf(merged, q.limit);
    return { items: items.map(({ atUs: _atUs, ...item }) => item), nextCursor };
  });

  app.get("/orgs/:orgId/pay-runs/:payRunId/items/:itemId/payslip", async (request) => {
    const { orgId, payRunId, itemId } = parse(payslipParams, request.params);
    await guards.requireRole(request, orgId, READERS);
    const rows = (await ledgerAttempts(deps.db, orgId)).filter(
      (r) => r.payRunId === payRunId && r.lineItemId === itemId,
    );
    if (rows.length === 0) throw notFound();
    // The successful attempt if there is one, otherwise the latest.
    const chosen =
      rows.find((r) => r.status === "SUCCESS") ?? rows.sort((a, b) => b.attemptNo - a.attemptNo)[0];
    const p = presentAttempt(chosen as AttemptRow);
    return {
      contractor: p.contractor,
      period: p.period,
      amount: p.amount,
      currency: p.currency,
      route: p.routeLabel,
      chain: chainName(p.chain),
      recipient: p.recipient,
      deliveryFee: p.deliveryFee,
      totalFee: p.totalFee,
      quoteAsOf: p.quoteAsOf,
      status: p.status,
      reconciled: p.reconciled,
      reconciledAt: p.reconciledAt,
      refundedAmount: p.refundedAmount,
      hashes: p.hashes,
      links: p.links,
      timestamps: p.statusHistory,
      attempts: rows.length,
      mode: p.mode,
      simulated: p.simulated,
      label: p.label,
    };
  });

  app.get("/orgs/:orgId/exports/payouts.csv", async (request, reply) => {
    const { orgId } = parse(orgParams, request.params);
    await guards.requireRole(request, orgId, READERS);
    const { from, to } = parse(csvQuery, request.query);
    if (from > to) throw invalidRequest();
    const start = new Date(`${from}T00:00:00.000Z`).getTime();
    const end = new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000; // `to` is inclusive.
    const rows = (await ledgerAttempts(deps.db, orgId))
      // Live only, and only payouts that reached 1Click: never a simulated record (L7).
      .filter((r) => r.mode === "live" && r.intentHash !== null)
      .map(presentAttempt)
      .filter((p) => {
        const t = new Date(p.at).getTime();
        return t >= start && t < end;
      })
      .sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)));
    const csv = toCsv(
      [
        "date",
        "pay run period",
        "contractor name",
        "amount",
        "currency",
        "route",
        "chain",
        "recipient",
        "delivery fee",
        "total fee",
        "status",
        "reconciled",
        "refunded amount",
        "deposit address",
        "intent hash",
        "NEAR tx hash",
        "destination tx hash",
        "destination explorer URL",
      ],
      rows.map((p) => [
        p.at,
        p.period,
        p.contractor.name,
        p.amount,
        p.currency,
        p.routeLabel,
        chainName(p.chain),
        p.recipient,
        p.deliveryFee,
        p.totalFee,
        p.status,
        p.reconciled ? "yes" : "no",
        p.refundedAmount ?? "0.000000",
        p.hashes.depositAddress,
        p.hashes.intentHash,
        p.hashes.nearTxHashes.join(" "),
        p.hashes.destinationTxHash,
        p.links.destinationTx,
      ]),
    );
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="payouts-${from}-to-${to}.csv"`)
      .send(csv);
  });

  app.get("/orgs/:orgId/audit", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    await guards.requireRole(request, orgId, READERS);
    const q = parse(auditQuery, request.query);
    const rows = await listAuditPage(
      deps.db,
      orgId,
      q.action,
      keyset(decodeCursor(q.cursor), q.limit),
    );
    const { items, nextCursor } = pageOf(rows, q.limit);
    // The audit log never stored a secret, a signature or a token; only these fields leave it.
    return {
      items: items.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actor: r.actor,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        txHash: r.txHash,
      })),
      nextCursor,
    };
  });
}
