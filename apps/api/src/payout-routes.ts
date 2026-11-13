// Signing and submit (ARCHITECTURE §6.3 steps 4 and 5). The server checks everything the browser
// gate will check, and hands over what the browser needs to check it independently (L16, L35).
import {
  canRetry,
  createRetryAttempt,
  formatAmount,
  getPayoutRoute,
  money,
  transitionPayRun,
  USDC,
  type PayoutAttempt,
  type PayoutRouteId,
} from "@veylo/core";
import {
  claimAttemptForSigning,
  consumeSignRequest,
  getCurrentHead,
  isItemAcknowledged,
  getPayRun,
  getPayRunItem,
  getSignRequest,
  insertEncumbrance,
  insertPayoutAttempt,
  insertSignRequest,
  listAttemptsByStatus,
  listAttemptsForItems,
  listDestinations,
  moveAttempt,
  setPayRunStatus,
  writeAudit,
} from "@veylo/db";
import {
  CONFIDENTIAL_TOKEN_PREFIX,
  CONFIDENTIAL_VERIFIER,
  shieldPayloadProblem,
  toSignedData,
  verifyNep413,
} from "@veylo/intents";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, type Deps } from "./app.js";
import { AppError, conflict, notFound } from "./errors.js";
import type { Guards } from "./guards.js";
import { destinationPayable, latestApproval, loadPayeeContext } from "./payability.js";
import { createTreasuryLimiter } from "./rate-limit.js";
import { createSettlement, encryptSignedPayload } from "./settlement.js";
import { assertTreasurySigner } from "./treasury-signer.js";

const OWNER_ONLY = ["owner"] as const;
/** Confidential debits are verified on intents.far (S-C, T5b, T5c). Salt read at runtime (L12). */
// The confidential token form 1Click generated in T5b, T5c and T5d, pinned as observed (L36). Both
// now live in @veylo/intents, shared with the browser gate.
export { CONFIDENTIAL_TOKEN_PREFIX };
const MIN_SECONDS_LEFT = 60;

const itemParams = z.object({ orgId: z.uuid(), payRunId: z.uuid(), itemId: z.uuid() });
const requestParams = itemParams.extend({ requestId: z.uuid() });
const signedBody = z
  .object({
    accountId: z.string().max(64),
    publicKey: z.string().max(128),
    signature: z.string().max(256),
  })
  .strict();

const rejectedSigner = () =>
  new AppError(403, "TREASURY_SIGNER_REJECTED", "Must be signed by the treasury account's wallet");

export async function payoutRoutes(app: FastifyInstance, deps: Deps, guards: Guards) {
  const limiter = createTreasuryLimiter({
    clock: deps.clock,
    perOrgPerHour: deps.config.treasuryLimitPerOrgPerHour ?? 60,
    perUserPerHour: deps.config.treasuryLimitPerUserPerHour ?? 30,
  });
  const settlement = createSettlement(deps);

  async function load(orgId: string, payRunId: string, itemId: string) {
    const run = await getPayRun(deps.db, orgId, payRunId);
    const item = run && (await getPayRunItem(deps.db, orgId, payRunId, itemId));
    if (!run || !item) throw notFound();
    const attempts = await listAttemptsForItems(deps.db, orgId, [item.id]);
    const latest = attempts.sort((a, b) => b.attemptNo - a.attemptNo)[0];
    return { run, item, attempts, latest };
  }

  app.post("/orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request", async (request, reply) => {
    const { orgId, payRunId, itemId } = parse(itemParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    limiter.check("sign-request", orgId, session.userId);
    const { run, item, latest } = await load(orgId, payRunId, itemId);
    if (run.mode === "simulated") {
      throw conflict("SIMULATED", "A simulated run never reaches signing");
    }
    if (run.status !== "Signing") throw conflict("RUN_WRONG_STATUS", `The run is ${run.status}`);
    // A warned item (a first payout, a new address, an unusual amount) needs the owner's tick (D5).
    const warned = ((item.flags ?? []) as { blocking: boolean }[]).some((f) => !f.blocking);
    if (warned && !(await isItemAcknowledged(deps.db, orgId, itemId))) {
      throw conflict(
        "ACKNOWLEDGEMENT_REQUIRED",
        'Read the warnings on this payout and tick "I\'ve checked this" first',
      );
    }
    if (
      !latest ||
      latest.status !== "QUOTED" ||
      !latest.depositAddress ||
      !latest.requestedDeadline
    ) {
      throw conflict("NOT_QUOTED", "This item has no live quote to sign");
    }
    const now = deps.clock();
    if (latest.requestedDeadline.getTime() - now.getTime() < MIN_SECONDS_LEFT * 1000) {
      throw conflict(
        "QUOTE_TOO_CLOSE_TO_DEADLINE",
        "Less than a minute is left on this quote. Re-quote it",
      );
    }

    // Gate B at sign time: a payee revoked since quoting fails the attempt here.
    const ctx = await loadPayeeContext(deps.db, orgId, item.contractorId, now);
    const destination = { id: item.destinationId as string };
    const rows = await listDestinations(deps.db, orgId, item.contractorId);
    const active = rows.find((d) => d.id === destination.id);
    const payable = active
      ? destinationPayable(ctx, active)
      : { payable: false, payableReason: "destination_superseded" };
    if (!payable.payable) {
      await moveAttempt(deps.db, orgId, latest.id, "QUOTED", {
        status: "FAILED",
        failureReason: "gate_blocked",
        failureDetail: payable.payableReason,
        terminalAt: now,
        statusHistory: [
          ...((latest.statusHistory as object[]) ?? []),
          { status: "FAILED", at: now.toISOString() },
        ],
      });
      await settlement.syncRun(orgId, payRunId);
      throw conflict("PAYEE_NOT_PAYABLE", `This payee can't be paid: ${payable.payableReason}`);
    }

    const treasury = ctx.treasuryAccountId;
    let saltHex: string;
    try {
      saltHex = await deps.intents.currentSalt(CONFIDENTIAL_VERIFIER);
    } catch (err) {
      request.log.warn({ err }, "could not read the verifier salt");
      throw new AppError(502, "RPC_UNAVAILABLE", "NEAR RPC is not available. Try again");
    }
    const payload = await deps.oneclickTreasury
      .generateSwapTransferIntent({ signerId: treasury, depositAddress: latest.depositAddress })
      .catch(() => {
        throw new AppError(502, "ONECLICK_UNAVAILABLE", "1Click is not available. Try again");
      });

    const quote = latest.quote as { quoteRequest: { originAsset: string } };
    // L36: the confidential token's account part is pinned as observed. Anything else stops here.
    const signedTokens = (() => {
      try {
        const m = JSON.parse(payload.message) as {
          intents?: { tokens?: Record<string, string> }[];
        };
        return Object.keys(m.intents?.[0]?.tokens ?? {});
      } catch {
        return [];
      }
    })();
    if (
      signedTokens.some((t) => t.startsWith("imt:") && !t.startsWith(CONFIDENTIAL_TOKEN_PREFIX))
    ) {
      request.log.error(
        { attemptId: latest.id },
        "unrecognized confidential token prefix: signing blocked",
      );
      throw new AppError(
        502,
        "unrecognized_confidential_token",
        "1Click generated a confidential token Veylo doesn't recognize, so signing is blocked. This needs review before any payout can be signed.",
      );
    }
    const problem = shieldPayloadProblem(payload, {
      signerId: treasury,
      depositAddress: latest.depositAddress,
      tokenId: `${CONFIDENTIAL_TOKEN_PREFIX}${quote.quoteRequest.originAsset}`,
      amount: (latest.amountIn as bigint).toString(),
      verifier: CONFIDENTIAL_VERIFIER,
      saltHex,
    });
    if (problem) {
      request.log.error(
        { problem, attemptId: latest.id },
        "1Click generated an unexpected payout intent",
      );
      throw new AppError(502, "UNEXPECTED_INTENT", "1Click generated an unexpected intent");
    }
    const messageDeadline = new Date(
      (JSON.parse(payload.message) as { deadline: string }).deadline,
    );
    if (Number.isNaN(messageDeadline.getTime())) {
      throw new AppError(502, "UNEXPECTED_INTENT", "1Click generated an unexpected intent");
    }
    await moveAttempt(deps.db, orgId, latest.id, "QUOTED", {
      signedMessageDeadline: messageDeadline,
    });

    const created = await insertSignRequest(deps.db, {
      orgId,
      attemptId: latest.id,
      payload,
      expiresAt: latest.requestedDeadline,
    });

    const approval = latestApproval(ctx, destination.id);
    const head = await getCurrentHead(deps.db, orgId);
    const route = getPayoutRoute(active!.route as PayoutRouteId);
    const amount = formatAmount(money(USDC, item.amountUsdc));
    const fee = formatAmount(money(USDC, (latest.amountIn as bigint) - item.amountUsdc));
    return reply.status(201).send({
      requestId: created.id,
      payload,
      expiresAt: latest.requestedDeadline,
      summary: `Pay ${amount} USDC to ${active!.address} (${route.label}), with up to ${fee} USDC in fees and buffer. Your wallet shows a transfer of ${(latest.amountIn as bigint).toString()} smallest units to ${latest.depositAddress}.`,
      // What the browser gate verifies on its own (L16). It must compute its own signing bound from
      // the quote's signed timestamp, never from a served deadline (L35).
      gate: {
        treasuryAccountId: treasury,
        quote: latest.quote,
        payeeApproval: approval
          ? {
              ...(approval.payload as object),
              ownerAccountId: approval.ownerAccountId,
              ownerPublicKey: approval.ownerPublicKey,
              signature: approval.signature,
              message: approval.message,
              contractorName: approval.contractorName,
              version: approval.version,
            }
          : null,
        registryHead: head
          ? {
              version: head.version,
              activeSetHash: head.activeSetHash,
              ownerPublicKey: head.ownerPublicKey,
              signature: head.signature,
              signedAt: head.signedAt,
              ...(head.payload as object),
            }
          : null,
      },
    });
  });

  app.post(
    "/orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request/:requestId/complete",
    async (request) => {
      const { orgId, payRunId, itemId, requestId } = parse(requestParams, request.params);
      const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
      const { latest } = await load(orgId, payRunId, itemId);
      const pending = await getSignRequest(deps.db, orgId, requestId);
      if (!pending || !latest || pending.attemptId !== latest.id) throw notFound();
      const body = parse(signedBody, request.body);
      const now = deps.clock();
      if (pending.usedAt !== null) throw conflict("REQUEST_USED", "This request was already used");
      if (pending.expiresAt.getTime() <= now.getTime()) {
        throw conflict("REQUEST_EXPIRED", "This quote's deadline has passed. Re-quote it");
      }
      if (latest.status !== "QUOTED")
        throw conflict("NOT_QUOTED", "This attempt can't be signed now");

      await assertTreasurySigner(deps, request.log, orgId, body, rejectedSigner);
      const payload = pending.payload as { message: string; nonce: string; recipient: string };
      // Nothing is stored or submitted unless the signature verifies here first.
      const signed = verifyNep413({
        ...payload,
        nonce: Buffer.from(payload.nonce, "base64"),
        publicKey: body.publicKey,
        signature: body.signature,
      });
      if (!signed) throw rejectedSigner();

      const signedData = toSignedData(payload, body);
      const ciphertext = await encryptSignedPayload(deps.db, deps.secrets, latest, signedData);
      const claimed = await deps.db.transaction(async (tx) => {
        if (!(await consumeSignRequest(tx, orgId, requestId, now))) return false;
        // QUOTED → SIGNED decides who submits: only one caller gets this row.
        if (
          !(await claimAttemptForSigning(tx, orgId, latest.id, {
            encryptedSignedPayload: ciphertext,
            statusHistory: [
              ...((latest.statusHistory as object[]) ?? []),
              { status: "SIGNED", at: now.toISOString() },
            ],
          }))
        ) {
          return false;
        }
        // The signed payload is a bearer authorization until its own deadline (L33, L34).
        await insertEncumbrance(tx, {
          orgId,
          attemptId: latest.id,
          amount: latest.amountIn as bigint,
          until: latest.signedMessageDeadline as Date,
        });
        await writeAudit(tx, {
          orgId,
          actor: session.userId,
          action: "payout.signed",
          entity: "payout_attempt",
          entityId: latest.id,
          at: now,
        });
        return true;
      });
      if (!claimed) throw conflict("REQUEST_USED", "This request was already used");

      const [row] = (await listAttemptsByStatus(deps.db, ["SIGNED"])).filter(
        (r) => r.id === latest.id,
      );
      if (row) await settlement.submit(row, request.log);
      const after = (await listAttemptsForItems(deps.db, orgId, [itemId])).find(
        (a) => a.id === latest.id,
      );
      return {
        attemptId: latest.id,
        status: after?.status,
        submitOutcome: after?.submitOutcome ?? null,
        intentHash: after?.intentHash ?? null,
      };
    },
  );

  app.post("/orgs/:orgId/pay-runs/:payRunId/items/:itemId/retry", async (request, reply) => {
    const { orgId, payRunId, itemId } = parse(itemParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const { run, item, attempts, latest } = await load(orgId, payRunId, itemId);
    if (!latest) throw conflict("NOT_RETRYABLE", "Nothing to retry");
    const now = deps.clock();

    // Rule 3: a fresh status check first. If 1Click shows the payment, it's not retried.
    if (latest.depositAddress && latest.mode === "live") {
      let status = "";
      try {
        status = String((await deps.oneclickTreasury.status(latest.depositAddress)).status ?? "");
      } catch {
        status = "";
      }
      if (["KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"].includes(status)) {
        throw conflict("NOT_RETRYABLE", `1Click shows this payout as ${status}`);
      }
    }
    const core: PayoutAttempt[] = attempts.map((a) => ({
      lineItemId: a.lineItemId,
      attemptNo: a.attemptNo,
      mode: a.mode,
      status: a.status,
      statusHistory: ((a.statusHistory as { status: never; at: string }[]) ?? []).map((h) => ({
        status: h.status,
        at: new Date(h.at),
      })),
      ...(a.reconciledAt ? { reconciledAt: a.reconciledAt } : {}),
    }));
    const latestCore = core.sort((a, b) => b.attemptNo - a.attemptNo)[0] as PayoutAttempt;
    if (!canRetry(latestCore)) throw conflict("NOT_RETRYABLE", `Can't retry from ${latest.status}`);
    const next = (() => {
      try {
        return createRetryAttempt({
          lineItemId: item.id,
          attempts: core,
          statusCheckedAt: now,
          at: now,
        });
      } catch (err) {
        throw conflict("NOT_RETRYABLE", (err as Error).message);
      }
    })();
    try {
      transitionPayRun({ id: run.id, status: run.status, mode: run.mode }, "Quoting");
    } catch {
      throw conflict("RUN_WRONG_STATUS", `Can't retry while the run is ${run.status}`);
    }
    await moveAttempt(deps.db, orgId, latest.id, latest.status, { statusCheckedAt: now });
    const inserted = await insertPayoutAttempt(deps.db, {
      orgId,
      lineItemId: item.id,
      attemptNo: next.attemptNo,
      status: "PLANNED",
      statusHistory: next.statusHistory,
      mode: item.mode,
    });
    if (!inserted) throw conflict("NOT_RETRYABLE", "This item already has an attempt in progress");
    if (await setPayRunStatus(deps.db, orgId, payRunId, run.status, "Quoting")) {
      await writeAudit(deps.db, {
        orgId,
        actor: session.userId,
        action: "pay_run.quoting",
        entity: "pay_run",
        entityId: payRunId,
        at: now,
      });
    }
    return reply.status(201).send({ attemptNo: next.attemptNo, status: "PLANNED" });
  });
}
