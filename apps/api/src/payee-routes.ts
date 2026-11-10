import { isOwnerKey } from "@veylo/chains";
import {
  approvalExpiry,
  canonicalPayeeRecord,
  getPayoutRoute,
  type PayeeRecord,
  type PayoutRouteId,
} from "@veylo/core";
import {
  consumePayeeRequest,
  getActiveMembershipByAccount,
  getApproval,
  getContractor,
  getCurrentHead,
  getDestination,
  getOrganization,
  getPayeeRequest,
  insertApproval,
  insertHead,
  insertPayeeRequest,
  listApprovalsForContractor,
  listApprovalsByHash,
  lockDestination,
  markApprovalRevoked,
  maxApprovalVersion,
  writeAudit,
  type Db,
} from "@veylo/db";
import {
  buildApprovalMessage,
  buildHeadMessage,
  payeeRecordHash,
  payeeSetHash,
  verifyNep413,
} from "@veylo/intents";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, type Deps } from "./app.js";
import { AppError, conflict, notFound } from "./errors.js";
import type { Guards } from "./guards.js";

const OWNER_ONLY = ["owner"] as const;
const REQUEST_TTL_MS = 10 * 60 * 1000;

const destinationParams = z.object({
  orgId: z.uuid(),
  contractorId: z.uuid(),
  destinationId: z.uuid(),
});
const destinationRequestParams = destinationParams.extend({ requestId: z.uuid() });
const approvalParams = z.object({ orgId: z.uuid(), approvalId: z.uuid() });
const approvalRequestParams = approvalParams.extend({ requestId: z.uuid() });
const orgParams = z.object({ orgId: z.uuid() });

const signature = z.string().max(256);
const signer = { accountId: z.string().max(64), publicKey: z.string().max(128) };
const completeApprovalBody = z
  .object({ ...signer, approvalSignature: signature, headSignature: signature })
  .strict();
const completeRevokeBody = z.object({ ...signer, headSignature: signature }).strict();

const rejectedSigner = () =>
  new AppError(403, "PAYEE_SIGNER_REJECTED", "Must be signed by the treasury account's wallet");
const staleHead = () => conflict("STALE_HEAD", "The registry changed. Start a new request");
const notApprovable = () =>
  conflict("DESTINATION_NOT_APPROVABLE", "Only an accepted, active destination can be approved");

type HeadPayload = { recordHashes: string[] };
type ApprovalPayload = { recordHash: string; canonicalRecord: string };

/** The trigger and unique constraints are the guarantee. This makes losing a race a clean 409. */
function isConcurrencyLoss(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } }).cause?.code;
  return code === "23505" || code === "23514";
}

export async function payeeRoutes(app: FastifyInstance, deps: Deps, guards: Guards) {
  const nonce = () => Buffer.from(deps.random(32)).toString("base64");
  const headHashes = (head: { payload: unknown } | undefined) =>
    head ? (head.payload as HeadPayload).recordHashes : [];

  /** Everything checked before signatures: cheap, and it spends nothing on a dead request. */
  function assertRequestLive(
    request: { usedAt: Date | null; expiresAt: Date; headVersion: number },
    currentVersion: number,
    now: Date,
  ) {
    if (request.usedAt !== null) throw conflict("REQUEST_USED", "This request was already used");
    if (request.expiresAt.getTime() <= now.getTime()) {
      throw conflict("REQUEST_EXPIRED", "This request has expired");
    }
    if (request.headVersion !== currentVersion + 1) throw staleHead();
  }

  /** L28: the treasury account itself, an active owner, with a key that is really its own. */
  async function assertTreasurySigner(
    log: { warn: (o: object, m: string) => void },
    orgId: string,
    accountId: string,
    publicKey: string,
  ) {
    const org = await getOrganization(deps.db, orgId);
    if (!org) throw notFound();
    if (accountId !== org.treasuryAccountId) throw rejectedSigner();
    const member = await getActiveMembershipByAccount(deps.db, orgId, accountId);
    if (member?.role !== "owner") throw rejectedSigner();
    let owns = false;
    try {
      owns = await isOwnerKey(deps.rpc, accountId, publicKey);
    } catch (err) {
      log.warn({ err }, "payee signer key check failed");
    }
    if (!owns) throw rejectedSigner();
  }

  app.post(
    "/orgs/:orgId/contractors/:contractorId/destinations/:destinationId/approval-request",
    async (request, reply) => {
      const { orgId, contractorId, destinationId } = parse(destinationParams, request.params);
      const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
      const contractor = await getContractor(deps.db, orgId, contractorId);
      const destination = await getDestination(deps.db, orgId, contractorId, destinationId);
      if (!contractor || !destination) throw notFound();
      if (
        contractor.status !== "active" ||
        destination.status !== "active" ||
        destination.checkStatus !== "accepted"
      ) {
        throw notApprovable();
      }

      const now = deps.clock();
      const route = getPayoutRoute(destination.route as PayoutRouteId);
      const version = (await maxApprovalVersion(deps.db, orgId, destinationId)) + 1;
      const record: PayeeRecord = {
        orgId,
        contractorId,
        destinationId,
        routeId: route.id,
        recipient: destination.address,
        recipientType: route.recipientType,
        version,
        approvedAt: now,
        expiresAt: approvalExpiry(now),
      };
      const recordHash = payeeRecordHash(record);
      const approvalMessage = buildApprovalMessage({
        record,
        contractorName: contractor.name,
        routeLabel: route.label,
      });

      // The current set, plus this approval, minus this contractor's superseded destinations and
      // any earlier approval of this same destination.
      const head = await getCurrentHead(deps.db, orgId);
      const theirs = await listApprovalsForContractor(deps.db, orgId, contractorId);
      const dropped = new Set(
        theirs
          .filter((a) => a.destinationStatus === "superseded" || a.destinationId === destinationId)
          .map((a) => (a.payload as ApprovalPayload).recordHash),
      );
      const recordHashes = [...headHashes(head).filter((h) => !dropped.has(h)), recordHash];
      const headVersion = (head?.version ?? 0) + 1;
      const headMessage = buildHeadMessage({
        orgId,
        version: headVersion,
        recordHashes,
        signedAt: now,
      });

      const created = await insertPayeeRequest(deps.db, {
        orgId,
        kind: "approve",
        destinationId,
        approvalId: null,
        requestedBy: session.userId,
        canonicalRecord: canonicalPayeeRecord(record),
        recordHash,
        approvalMessage,
        contractorName: contractor.name,
        approvalNonce: nonce(),
        approvedAt: now,
        expiresRecordAt: record.expiresAt,
        approvalVersion: version,
        headVersion,
        headMessage,
        headNonce: nonce(),
        headRecordHashes: recordHashes,
        headSignedAt: now,
        expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
      });
      return reply.status(201).send({
        requestId: created.id,
        approvalMessage,
        approvalNonce: created.approvalNonce,
        headMessage,
        headNonce: created.headNonce,
        recipient: deps.config.authRecipient,
        expiresAt: created.expiresAt,
      });
    },
  );

  app.post(
    "/orgs/:orgId/contractors/:contractorId/destinations/:destinationId/approval-request/:requestId/complete",
    async (request) => {
      const { orgId, contractorId, destinationId, requestId } = parse(
        destinationRequestParams,
        request.params,
      );
      const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
      const pending = await getPayeeRequest(deps.db, orgId, requestId);
      if (!pending || pending.kind !== "approve" || pending.destinationId !== destinationId) {
        throw notFound();
      }
      const destinationNow = await getDestination(deps.db, orgId, contractorId, destinationId);
      if (!destinationNow) throw notFound();
      const body = parse(completeApprovalBody, request.body);
      const now = deps.clock();
      const head = await getCurrentHead(deps.db, orgId);
      assertRequestLive(pending, head?.version ?? 0, now);

      await assertTreasurySigner(request.log, orgId, body.accountId, body.publicKey);
      const recipient = deps.config.authRecipient;
      const signed =
        verifyNep413({
          message: pending.approvalMessage as string,
          nonce: Buffer.from(pending.approvalNonce as string, "base64"),
          recipient,
          publicKey: body.publicKey,
          signature: body.approvalSignature,
        }) &&
        verifyNep413({
          message: pending.headMessage,
          nonce: Buffer.from(pending.headNonce, "base64"),
          recipient,
          publicKey: body.publicKey,
          signature: body.headSignature,
        });
      if (!signed) throw rejectedSigner();

      try {
        return await deps.db.transaction(async (tx) => {
          if (!(await consumePayeeRequest(tx, orgId, requestId, now))) {
            throw conflict("REQUEST_USED", "This request was already used");
          }
          // Locked, so the destination can't be superseded between this check and the commit.
          const destination = await lockDestination(tx, orgId, destinationId);
          const contractor = await getContractor(tx, orgId, contractorId);
          if (
            destination?.status !== "active" ||
            destination.checkStatus !== "accepted" ||
            contractor?.status !== "active"
          ) {
            throw notApprovable();
          }
          const approval = await insertApproval(tx, {
            orgId,
            destinationId,
            version: pending.approvalVersion as number,
            payload: {
              canonicalRecord: pending.canonicalRecord,
              recordHash: pending.recordHash,
              message: pending.approvalMessage,
              nonce: pending.approvalNonce,
              recipient,
            },
            message: pending.approvalMessage as string,
            contractorName: pending.contractorName as string,
            ownerAccountId: body.accountId,
            ownerPublicKey: body.publicKey,
            signature: body.approvalSignature,
            approvedAt: pending.approvedAt as Date,
            expiresAt: pending.expiresRecordAt as Date,
          });
          await insertHeadFrom(tx, pending, body);
          await audit(
            tx,
            orgId,
            session.userId,
            "payee.approve",
            "payee_approval",
            approval.id,
            now,
          );
          return { approvalId: approval.id, headVersion: pending.headVersion };
        });
      } catch (err) {
        if (isConcurrencyLoss(err)) throw staleHead();
        throw err;
      }
    },
  );

  function insertHeadFrom(
    tx: Db,
    pending: NonNullable<Awaited<ReturnType<typeof getPayeeRequest>>>,
    body: { accountId: string; publicKey: string; headSignature: string },
  ) {
    const recordHashes = pending.headRecordHashes as string[];
    return insertHead(tx, {
      orgId: pending.orgId,
      version: pending.headVersion,
      activeSetHash: payeeSetHash(recordHashes),
      payload: {
        message: pending.headMessage,
        nonce: pending.headNonce,
        recipient: deps.config.authRecipient,
        signerAccountId: body.accountId,
        recordHashes,
      },
      ownerPublicKey: body.publicKey,
      signature: body.headSignature,
      signedAt: pending.headSignedAt,
    });
  }

  function audit(
    tx: Db,
    orgId: string,
    actor: string,
    action: string,
    entity: string,
    entityId: string,
    at: Date,
  ) {
    return writeAudit(tx, { orgId, actor, action, entity, entityId, at });
  }

  app.post("/orgs/:orgId/payees/:approvalId/revoke-request", async (request, reply) => {
    const { orgId, approvalId } = parse(approvalParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const approval = await getApproval(deps.db, orgId, approvalId);
    if (!approval) throw notFound();
    if (approval.revokedAt !== null) throw conflict("ALREADY_REVOKED", "Already revoked");

    const now = deps.clock();
    const head = await getCurrentHead(deps.db, orgId);
    const target = (approval.payload as ApprovalPayload).recordHash;
    const recordHashes = headHashes(head).filter((h) => h !== target);
    const headVersion = (head?.version ?? 0) + 1;
    const headMessage = buildHeadMessage({
      orgId,
      version: headVersion,
      recordHashes,
      signedAt: now,
    });
    const created = await insertPayeeRequest(deps.db, {
      orgId,
      kind: "revoke",
      destinationId: approval.destinationId,
      approvalId,
      requestedBy: session.userId,
      canonicalRecord: null,
      recordHash: null,
      approvalMessage: null,
      contractorName: null,
      approvalNonce: null,
      approvedAt: null,
      expiresRecordAt: null,
      approvalVersion: null,
      headVersion,
      headMessage,
      headNonce: nonce(),
      headRecordHashes: recordHashes,
      headSignedAt: now,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    });
    return reply.status(201).send({
      requestId: created.id,
      headMessage,
      headNonce: created.headNonce,
      recipient: deps.config.authRecipient,
      expiresAt: created.expiresAt,
    });
  });

  app.post(
    "/orgs/:orgId/payees/:approvalId/revoke-request/:requestId/complete",
    async (request) => {
      const { orgId, approvalId, requestId } = parse(approvalRequestParams, request.params);
      const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
      const pending = await getPayeeRequest(deps.db, orgId, requestId);
      if (!pending || pending.kind !== "revoke" || pending.approvalId !== approvalId) {
        throw notFound();
      }
      const body = parse(completeRevokeBody, request.body);
      const now = deps.clock();
      const head = await getCurrentHead(deps.db, orgId);
      assertRequestLive(pending, head?.version ?? 0, now);

      await assertTreasurySigner(request.log, orgId, body.accountId, body.publicKey);
      const signed = verifyNep413({
        message: pending.headMessage,
        nonce: Buffer.from(pending.headNonce, "base64"),
        recipient: deps.config.authRecipient,
        publicKey: body.publicKey,
        signature: body.headSignature,
      });
      if (!signed) throw rejectedSigner();

      try {
        return await deps.db.transaction(async (tx) => {
          if (!(await consumePayeeRequest(tx, orgId, requestId, now))) {
            throw conflict("REQUEST_USED", "This request was already used");
          }
          await markApprovalRevoked(tx, orgId, approvalId, now);
          await insertHeadFrom(tx, pending, body);
          await audit(tx, orgId, session.userId, "payee.revoke", "payee_approval", approvalId, now);
          return { approvalId, headVersion: pending.headVersion };
        });
      } catch (err) {
        if (isConcurrencyLoss(err)) throw staleHead();
        throw err;
      }
    },
  );

  app.get("/orgs/:orgId/payee-registry", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    await guards.requireMember(request, orgId);
    const head = await getCurrentHead(deps.db, orgId);
    if (!head) return { head: null, approvals: [] };
    const approvals = await listApprovalsByHash(deps.db, orgId, headHashes(head));
    return {
      head: {
        version: head.version,
        activeSetHash: head.activeSetHash,
        ownerPublicKey: head.ownerPublicKey,
        signature: head.signature,
        signedAt: head.signedAt,
        ...(head.payload as object),
      },
      approvals: approvals.map((a) => ({
        id: a.id,
        destinationId: a.destinationId,
        version: a.version,
        contractorName: a.contractorName,
        ownerAccountId: a.ownerAccountId,
        ownerPublicKey: a.ownerPublicKey,
        signature: a.signature,
        approvedAt: a.approvedAt,
        expiresAt: a.expiresAt,
        ...(a.payload as object),
        message: a.message,
      })),
    };
  });
}
