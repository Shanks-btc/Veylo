// Settlement (ARCHITECTURE §6.3 steps 5 and 6, §6.4, rules 2 to 5). Every job is a sweep over rows
// that are due, and every write is a conditional UPDATE on the state it read, so a job delivered
// twice, or run by two workers at once, changes nothing the second time.
import {
  derivePayRunStatus,
  isReconcilable,
  isTerminal,
  mapOneClickStatus,
  ONECLICK_HAS_INTENT,
  PAY_RUN_TRANSITIONS,
  transitionPayRun,
  type AttemptStatus,
  type FailureReason,
  type PayRunStatus,
} from "@veylo/core";
import {
  getOrCreateWrappedDataKey,
  getPayRun,
  listAttemptsByStatus,
  listAttemptsForItems,
  listDueEncumbrances,
  listPayRunItems,
  listPayloadsToDelete,
  markDestinationPubliclyPaid,
  moveAttempt,
  releaseEncumbrance,
  setPayRunStatus,
  writeAudit,
  type Db,
} from "@veylo/db";
import { OneClickError, type Nep413SignedData } from "@veylo/intents";
import type { SecretBox } from "@veylo/secrets";
import type { Deps } from "./app.js";
import { createSessionAccess } from "./oneclick-session.js";

export const SIGNED_PAYLOAD = "signed_payload";
/** Bounded: an uncertain submit is resubmitted, identical, at most this many times (L34). */
export const MAX_SUBMITS = 3;
/** Refunds lag right after SUCCESS (rule 5), so reconciliation waits this long. */
export const RECONCILE_DELAY_MS = 30_000;
const EXPIRED_AT_SUBMIT = /quote has expired/i;

type Log = {
  info: (o: object, m: string) => void;
  warn: (o: object, m: string) => void;
  error: (o: object, m: string) => void;
};
export type SettlementDeps = Pick<
  Deps,
  "db" | "clock" | "oneclickTreasury" | "secrets" | "intents" | "rpc" | "config"
>;
type AttemptRow = Awaited<ReturnType<typeof listAttemptsByStatus>>[number];

const binding = (row: { orgId: string; id: string }) => ({
  orgId: row.orgId,
  purpose: SIGNED_PAYLOAD,
  recordId: row.id,
});

export async function encryptSignedPayload(
  db: Db,
  secrets: SecretBox,
  row: { orgId: string; id: string },
  signedData: Nep413SignedData,
) {
  const wrapped = await getOrCreateWrappedDataKey(db, row.orgId, () =>
    secrets.newWrappedDataKey(row.orgId),
  );
  return secrets.encrypt(wrapped, binding(row), JSON.stringify(signedData));
}

export function createSettlement(deps: SettlementDeps) {
  const session = createSessionAccess(deps as Deps);

  async function decryptPayload(row: AttemptRow): Promise<Nep413SignedData> {
    const wrapped = await getOrCreateWrappedDataKey(deps.db, row.orgId, () =>
      deps.secrets.newWrappedDataKey(row.orgId),
    );
    return JSON.parse(
      deps.secrets.decrypt(wrapped, binding(row), row.encryptedSignedPayload as string),
    ) as Nep413SignedData;
  }

  function history(row: AttemptRow, to: AttemptStatus) {
    return [
      ...((row.statusHistory as { status: string; at: string }[]) ?? []),
      { status: to, at: deps.clock().toISOString() },
    ];
  }

  /** Moves an attempt only if it's still in the state read. Returns false if someone else moved it. */
  function move(
    row: AttemptRow,
    to: AttemptStatus,
    values: Record<string, unknown> = {},
    failureReason?: FailureReason,
  ) {
    return moveAttempt(deps.db, row.orgId, row.id, row.status, {
      status: to,
      statusHistory: history(row, to),
      ...(failureReason ? { failureReason } : {}),
      ...(isTerminal(to) ? { terminalAt: deps.clock() } : {}),
      ...values,
    });
  }

  /** Walks the run to the status its items imply, one table step at a time, auditing each. */
  async function syncRun(orgId: string, payRunId: string) {
    const run = await getPayRun(deps.db, orgId, payRunId);
    if (!run) return;
    const items = await listPayRunItems(deps.db, orgId, payRunId);
    const rows = await listAttemptsForItems(
      deps.db,
      orgId,
      items.map((i) => i.id),
    );
    const target = derivePayRunStatus(
      items.map((i) => ({
        id: i.id,
        mode: i.mode,
        amount: { asset: { assetId: "usdc", decimals: 6 }, units: i.amountUsdc } as never,
        attempts: rows
          .filter((r) => r.lineItemId === i.id)
          .map((r) => ({
            lineItemId: r.lineItemId,
            attemptNo: r.attemptNo,
            mode: r.mode,
            status: r.status,
            statusHistory: [],
          })),
      })),
    );
    if (!target || target === run.status) return;
    const path = shortestPath(run.status, target);
    let from = run.status;
    for (const to of path) {
      transitionPayRun({ id: run.id, status: from, mode: run.mode }, to);
      if (!(await setPayRunStatus(deps.db, orgId, payRunId, from, to))) return;
      await writeAudit(deps.db, {
        orgId,
        actor: "worker",
        action: `pay_run.${to.toLowerCase()}`,
        entity: "pay_run",
        entityId: payRunId,
        at: deps.clock(),
      });
      from = to;
    }
  }

  async function runOf(row: AttemptRow) {
    if (row.payRunId) await syncRun(row.orgId, row.payRunId);
  }

  /**
   * Submits the stored signed payload. Called right after signing, and again (identical, never
   * re-signed) when an earlier submit's outcome was unknown (L34, S-E).
   */
  async function submit(row: AttemptRow, log: Log) {
    const signedData = await decryptPayload(row);
    const attempts = (row.submitAttempts ?? 0) + 1;
    try {
      const result = await deps.oneclickTreasury.submitIntent(signedData);
      if (row.intentHash && row.intentHash !== result.intentHash) {
        log.error({ attemptId: row.id }, "1Click returned a different intentHash for a resubmit");
      }
      // A repeated identical intentHash means "already submitted" (S-E): same state either way.
      await move(row, "SUBMITTED", {
        intentHash: result.intentHash,
        submitOutcome: "submitted",
        submitAttempts: attempts,
      });
    } catch (err) {
      if (!(err instanceof OneClickError)) throw err;
      if (err.kind === "rejected" && EXPIRED_AT_SUBMIT.test(err.detail)) {
        await move(row, "EXPIRED", { submitOutcome: "rejected", submitAttempts: attempts });
      } else if (err.kind === "rejected" || err.kind === "unauthorized") {
        await move(
          row,
          "FAILED",
          { submitOutcome: "rejected", submitAttempts: attempts, failureDetail: err.detail },
          "submit_rejected",
        );
      } else {
        // Network, 5xx, timeout: it may or may not have arrived. Stays SIGNED for the resolver.
        await moveAttempt(deps.db, row.orgId, row.id, row.status, {
          submitOutcome: "uncertain",
          submitAttempts: attempts,
        });
      }
    }
    await runOf(row);
  }

  /** Records what 1Click reports, keeping every hash (rule 2). */
  async function applyStatus(row: AttemptRow, body: Record<string, any>, log: Log) {
    const observed = String(body.status ?? "");
    const d = (body.swapDetails ?? {}) as Record<string, any>;
    const hashes = {
      settlementIntentHashes: Array.isArray(d.intentHashes) ? d.intentHashes : [],
      nearTxHashes: Array.isArray(d.nearTxHashes) ? d.nearTxHashes : [],
      destinationTxHash:
        Array.isArray(d.destinationChainTxHashes) && d.destinationChainTxHashes[0]?.hash
          ? String(d.destinationChainTxHashes[0].hash)
          : null,
      lastStatus: { status: observed, updatedAt: body.updatedAt ?? null },
    };
    const mapped = mapOneClickStatus(row.status, observed);
    if (mapped.alert)
      log.error({ attemptId: row.id, observed: observed.slice(0, 40) }, mapped.alert);
    if (!mapped.to) {
      await moveAttempt(deps.db, row.orgId, row.id, row.status, hashes);
      return;
    }
    const moved = await move(row, mapped.to, hashes, mapped.failureReason);
    if (!moved) return;
    if (mapped.to === "SUCCESS") {
      // The nonce is spent, so nothing can execute this payload again.
      await releaseEncumbrance(deps.db, row.orgId, row.id, "success", deps.clock());
      // Rule 8: a Direct payout landed on a public chain, from the company.
      if (row.payoutMode === "direct" && row.destinationId) {
        await markDestinationPubliclyPaid(deps.db, row.orgId, row.destinationId);
      }
    }
    await runOf(row);
  }

  async function readStatus(row: AttemptRow, log: Log) {
    try {
      return await deps.oneclickTreasury.status(row.depositAddress as string);
    } catch (err) {
      if (err instanceof OneClickError && err.kind === "rejected") return undefined;
      log.warn({ attemptId: row.id }, "status check failed");
      return null;
    }
  }

  return {
    submit,
    syncRun,

    /** SUBMITTED and PROCESSING attempts. */
    async pollPayoutStatus(log: Log) {
      for (const row of await listAttemptsByStatus(deps.db, ["SUBMITTED", "PROCESSING"])) {
        const body = await readStatus(row, log);
        if (body) await applyStatus(row, body, log);
      }
    },

    /** SIGNED attempts whose submit outcome is unknown. */
    async resolveUncertainSubmits(log: Log) {
      const now = deps.clock();
      for (const row of await listAttemptsByStatus(deps.db, ["SIGNED"])) {
        if (row.submitOutcome !== "uncertain") continue;
        const body = await readStatus(row, log);
        if (body === null) continue; // Couldn't ask. Try again next time.
        const s = String(body?.status ?? "");
        const known =
          body !== undefined &&
          (ONECLICK_HAS_INTENT.has(s) ||
            (((body as Record<string, any>).swapDetails?.intentHashes as unknown[]) ?? []).length >
              0);
        if (known) {
          if (await move(row, "SUBMITTED", { submitOutcome: "submitted" })) {
            const fresh = (await listAttemptsByStatus(deps.db, ["SUBMITTED"])).find(
              (r) => r.id === row.id,
            );
            if (fresh && body) await applyStatus(fresh, body, log);
            else await runOf(row);
          }
          continue;
        }
        const deadline = row.requestedDeadline as Date;
        if (now.getTime() < deadline.getTime()) {
          // Before the deadline: resubmit the identical payload. Never re-sign (L34).
          if ((row.submitAttempts ?? 0) < MAX_SUBMITS) await submit(row, log);
        } else {
          // Past the deadline 1Click refuses it (S-E2), so it can't run through 1Click. The payload
          // stays a bearer authorization until its own deadline, so its encumbrance stays too.
          await move(row, "EXPIRED", { expiredUnsubmitted: true });
          await runOf(row);
        }
      }
    },

    /** QUOTED attempts past their requested deadline: 1Click will refuse them now. */
    async expireQuotes(_log: Log) {
      const now = deps.clock();
      for (const row of await listAttemptsByStatus(deps.db, ["QUOTED"])) {
        if (row.mode !== "live" || !row.requestedDeadline) continue;
        if (row.requestedDeadline.getTime() <= now.getTime()) {
          if (await move(row, "EXPIRED")) await runOf(row);
        }
      }
    },

    /** At least 30 s after terminal: refunds lag (rule 5). */
    async reconcilePayouts(log: Log) {
      const now = deps.clock();
      for (const row of await listAttemptsByStatus(deps.db, ["SUCCESS", "REFUNDED", "FAILED"])) {
        if (row.mode !== "live" || row.reconciledAt || !row.terminalAt) continue;
        if (!isReconcilable({ status: row.status, failureReason: row.failureReason ?? undefined }))
          continue;
        if (now.getTime() - row.terminalAt.getTime() < RECONCILE_DELAY_MS) continue;
        const body = await readStatus(row, log);
        if (body === null) continue;
        const refunded = (body as Record<string, any> | undefined)?.swapDetails?.refundedAmount;
        const balance = await session.confidentialBalance(log as never, row.orgId);
        const updated = await moveAttempt(deps.db, row.orgId, row.id, row.status, {
          reconciledAt: now,
          refundedAmount:
            typeof refunded === "string" && /^\d+$/.test(refunded) ? BigInt(refunded) : null,
          balanceUnconfirmed: balance.status !== "ok",
          observedBalance: balance.status === "ok" ? balance.amount : null,
        });
        if (updated && row.status !== "SUCCESS") {
          await releaseEncumbrance(deps.db, row.orgId, row.id, "reconciled", now);
        }
      }
    },

    /** EXPIRED and submit_rejected: released only once the signed message's own deadline passes. */
    async releaseEncumbrances(_log: Log) {
      const now = deps.clock();
      for (const e of await listDueEncumbrances(deps.db, now)) {
        const deadlineRelease =
          e.attemptStatus === "EXPIRED" ||
          (e.attemptStatus === "FAILED" && e.failureReason === "submit_rejected");
        const successRelease = e.attemptStatus === "SUCCESS";
        if (deadlineRelease || successRelease) {
          await releaseEncumbrance(
            deps.db,
            e.orgId,
            e.attemptId,
            successRelease ? "success" : "message_deadline_passed",
            now,
          );
        }
      }
      // The bearer copy goes once it can't do anything: settled, or past its message deadline.
      for (const row of await listPayloadsToDelete(deps.db, now)) {
        await moveAttempt(deps.db, row.orgId, row.id, row.status, {
          encryptedSignedPayload: null,
          payloadDeletedAt: now,
        });
      }
    },
  };
}

function shortestPath(from: PayRunStatus, to: PayRunStatus): PayRunStatus[] {
  const queue: PayRunStatus[][] = [[from]];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const path = queue.shift() as PayRunStatus[];
    const last = path.at(-1) as PayRunStatus;
    if (last === to) return path.slice(1);
    for (const next of PAY_RUN_TRANSITIONS[last]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push([...path, next]);
      }
    }
  }
  return [];
}
