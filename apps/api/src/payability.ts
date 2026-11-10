// The server's replica of gate B (L16): whether a destination can be paid right now. Shared by the
// destination views and the pay-run review, approval and quote steps, so they can't disagree.
import { payeeStatus, type PayeeRecord } from "@veylo/core";
import {
  getContractor,
  getCurrentHead,
  getOrganization,
  listApprovalsForContractor,
  type Db,
} from "@veylo/db";
import { notFound } from "./errors.js";

export async function loadPayeeContext(db: Db, orgId: string, contractorId: string, now: Date) {
  const [org, contractor, head, approvals] = await Promise.all([
    getOrganization(db, orgId),
    getContractor(db, orgId, contractorId),
    getCurrentHead(db, orgId),
    listApprovalsForContractor(db, orgId, contractorId),
  ]);
  if (!org || !contractor) throw notFound();
  const headRecordHashes = head ? (head.payload as { recordHashes: string[] }).recordHashes : [];
  return {
    now,
    supersededInHead: approvals.some(
      (a) =>
        a.destinationStatus === "superseded" &&
        headRecordHashes.includes((a.payload as { recordHash: string }).recordHash),
    ),
    treasuryAccountId: org.treasuryAccountId,
    contractorStatus: contractor.status,
    headRecordHashes,
    approvals,
  };
}

export type PayeeContext = Awaited<ReturnType<typeof loadPayeeContext>>;

/** The destination's highest-version approval, if any. */
export function latestApproval(ctx: PayeeContext, destinationId: string) {
  return ctx.approvals
    .filter((a) => a.destinationId === destinationId)
    .sort((a, b) => b.version - a.version)[0];
}

export function destinationPayable(
  ctx: PayeeContext,
  row: { id: string; status: "candidate" | "active" | "superseded"; checkStatus: string },
) {
  const latest = latestApproval(ctx, row.id);
  return payeeStatus({
    contractorStatus: ctx.contractorStatus,
    destinationStatus: row.status,
    checkStatus: row.checkStatus,
    treasuryAccountId: ctx.treasuryAccountId,
    ...(latest
      ? {
          approval: {
            ownerAccountId: latest.ownerAccountId,
            expiresAt: latest.expiresAt,
            revokedAt: latest.revokedAt,
            recordHash: (latest.payload as { recordHash: string }).recordHash,
          },
        }
      : {}),
    headRecordHashes: ctx.headRecordHashes,
    supersededInHead: ctx.supersededInHead,
    now: ctx.now,
  });
}

/** What the treasury signed for this destination: the recipient a payout quote must match. */
export function signedPayee(ctx: PayeeContext, destinationId: string) {
  const latest = latestApproval(ctx, destinationId);
  if (!latest) return undefined;
  const record = JSON.parse((latest.payload as { canonicalRecord: string }).canonicalRecord) as {
    recipient: string;
    recipientType: PayeeRecord["recipientType"];
    routeId: string;
  };
  return { approvalId: latest.id, ...record };
}
