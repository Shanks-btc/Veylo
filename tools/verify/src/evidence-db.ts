import { ledgerAttempts, ledgerTreasuryEvents, listOrgIds, type Db } from "@veylo/db";
import { getPayoutRoute, type PayoutRouteId } from "@veylo/core";
import type { EvidenceRow } from "./evidence.js";

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];

/** Section 1 rows: live, reconciled SUCCESS payouts and SUCCESS treasury events. Never simulated. */
export async function productEvidenceRows(db: Db): Promise<EvidenceRow[]> {
  const rows: EvidenceRow[] = [];
  for (const orgId of await listOrgIds(db)) {
    for (const a of await ledgerAttempts(db, orgId)) {
      if (a.mode !== "live" || a.status !== "SUCCESS" || a.reconciledAt === null) continue;
      const route = a.route ? getPayoutRoute(a.route as PayoutRouteId) : undefined;
      const date = (a.terminalAt ?? a.createdAt).toISOString().replace(/\.\d{3}Z$/, "Z");
      const event = `Payout ${a.period}: ${route?.label ?? "unknown route"}`;
      const source = `pay run ${a.payRunId}, attempt ${a.id}`;
      for (const tx of strings(a.nearTxHashes)) {
        rows.push({
          date,
          event: `${event}, NEAR side`,
          chain: "near",
          tx,
          party: "intents.near",
          source,
        });
      }
      if (a.destinationTxHash && route && route.chain !== "near" && a.recipient) {
        rows.push({
          date,
          event: `${event}, delivered`,
          chain: route.chain === "arb" ? "arb" : route.chain === "sol" ? "sol" : "base",
          tx: a.destinationTxHash,
          party: a.recipient,
          amount: { units: a.amountUsdc, symbol: "USDC", decimals: 6 },
          source,
        });
      }
    }
    for (const e of await ledgerTreasuryEvents(db, orgId)) {
      if (e.mode !== "live" || e.status !== "SUCCESS") continue;
      const body = (e.lastStatus ?? {}) as { swapDetails?: Record<string, unknown> };
      const date = e.createdAt.toISOString().replace(/\.\d{3}Z$/, "Z");
      for (const tx of strings(body.swapDetails?.nearTxHashes)) {
        rows.push({
          date,
          event: `Treasury ${e.type}, NEAR side`,
          chain: "near",
          tx,
          party: "intents.near",
          source: `treasury event ${e.id}`,
        });
      }
    }
  }
  return rows;
}
