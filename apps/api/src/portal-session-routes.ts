// A contractor's own private balance (slice W6, follow-up 2). Reading it needs a 1Click session that
// only the contractor's wallet can open, by signing an EMPTY intent: it moves nothing and can only
// read. The rules mirror the treasury's (L28, L30, T-10):
//   - the signer is the NEAR account this person signed in with, and the key is really that account's;
//   - the request is single-use and expires in five minutes;
//   - 1Click's tokens are stored encrypted with the org's data key, bound to this row and purpose,
//     and never logged or returned;
//   - a balance is shown only when 1Click answered. No guess, no stale number.
// Moving the money (cash-out) is not here: it waits for spike S-P.
import { randomUUID } from "node:crypto";
import { isOwnerKey } from "@veylo/chains";
import { TREASURY_ASSET_ID } from "@veylo/core";
import {
  consumeContractorSessionRequest,
  findContractorOneClickSession,
  getContractorSessionRequest,
  getOrCreateWrappedDataKey,
  getUser,
  insertContractorSessionRequest,
  markContractorOneClickSessionNeedsResign,
  saveContractorOneClickSession,
  updateContractorOneClickAccessToken,
  writeAudit,
} from "@veylo/db";
import {
  encodeVersionedNonce,
  OneClickError,
  sessionMessage,
  toSignedData,
  verifyNep413,
} from "@veylo/intents";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, type Deps } from "./app.js";
import { AppError, conflict, notFound } from "./errors.js";
import { createTreasuryLimiter } from "./rate-limit.js";

/** Docs: recipient `intents.near`; the salt is read at runtime (L12). */
const VERIFIER = "intents.near";
const REQUEST_TTL_MS = 5 * 60 * 1000;
const ACCESS = "portal.oneclick.access";
const REFRESH = "portal.oneclick.refresh";
const SOURCE = "1Click: /v0/account/balances";

const params = z.object({ contractorId: z.uuid() });
const requestParams = z.object({ contractorId: z.uuid(), id: z.uuid() });
const signedBody = z
  .object({
    accountId: z.string().max(64),
    publicKey: z.string().max(128),
    signature: z.string().max(256),
  })
  .strict();

type Own = (
  request: FastifyRequest,
  contractorId: string,
) => Promise<{
  session: { userId: string };
  contractor: { id: string; orgId: string };
}>;

const rejectedSigner = () =>
  new AppError(403, "WALLET_REJECTED", "Must be signed by the wallet you signed in with");

export async function portalSessionRoutes(app: FastifyInstance, deps: Deps, own: Own) {
  const limiter = createTreasuryLimiter({
    clock: deps.clock,
    perOrgPerHour: 600,
    perUserPerHour: 20,
  });

  /** The NEAR account this person signed in with. An email-only account has none yet. */
  async function walletOf(userId: string): Promise<string> {
    const user = await getUser(deps.db, userId);
    if (!user?.nearAccountId) {
      throw new AppError(
        409,
        "WALLET_REQUIRED",
        "Link a NEAR wallet to your account to read your private balance",
      );
    }
    return user.nearAccountId;
  }

  /** A usable access token, refreshed on the server. Undefined means the wallet must sign again. */
  async function accessToken(
    log: FastifyBaseLogger,
    orgId: string,
    contractorId: string,
  ): Promise<string | undefined> {
    const row = await findContractorOneClickSession(deps.db, orgId, contractorId);
    if (!row || row.status !== "active") return undefined;
    const now = deps.clock();
    const wrapped = await getOrCreateWrappedDataKey(deps.db, orgId, () =>
      deps.secrets.newWrappedDataKey(orgId),
    );
    const recordId = row.id;
    if (row.accessExpiresAt.getTime() > now.getTime()) {
      return deps.secrets.decrypt(
        wrapped,
        { orgId, purpose: ACCESS, recordId },
        row.encryptedAccessToken,
      );
    }
    if (row.refreshExpiresAt.getTime() <= now.getTime()) {
      await markContractorOneClickSessionNeedsResign(deps.db, contractorId);
      return undefined;
    }
    const refreshToken = deps.secrets.decrypt(
      wrapped,
      { orgId, purpose: REFRESH, recordId },
      row.encryptedRefreshToken,
    );
    try {
      const fresh = await deps.oneclickTreasury.refresh(refreshToken);
      await updateContractorOneClickAccessToken(deps.db, contractorId, {
        encryptedAccessToken: deps.secrets.encrypt(
          wrapped,
          { orgId, purpose: ACCESS, recordId },
          fresh.accessToken,
        ),
        accessExpiresAt: new Date(now.getTime() + fresh.expiresIn * 1000),
      });
      return fresh.accessToken;
    } catch (err) {
      if (err instanceof OneClickError && err.kind === "unauthorized") {
        await markContractorOneClickSessionNeedsResign(deps.db, contractorId);
        return undefined;
      }
      throw err;
    }
  }

  app.post("/portal/contractors/:contractorId/session-request", async (request, reply) => {
    const { contractorId } = parse(params, request.params);
    const { session, contractor } = await own(request, contractorId);
    limiter.check("portal-session-request", contractor.orgId, session.userId);
    const account = await walletOf(session.userId);
    const now = deps.clock();
    const deadline = new Date(now.getTime() + REQUEST_TTL_MS);
    let saltHex: string;
    try {
      saltHex = await deps.intents.currentSalt(VERIFIER);
    } catch (err) {
      request.log.warn({ err }, "could not read the verifier salt");
      throw new AppError(502, "RPC_UNAVAILABLE", "NEAR RPC is not available. Try again");
    }
    const payload = {
      message: sessionMessage(account, deadline),
      nonce: encodeVersionedNonce({ saltHex, deadline, start: now, random: deps.random(7) }),
      recipient: VERIFIER,
    };
    const created = await insertContractorSessionRequest(deps.db, {
      orgId: contractor.orgId,
      contractorId,
      accountId: account,
      message: payload.message,
      nonce: payload.nonce,
      recipient: payload.recipient,
      expiresAt: deadline,
    });
    return reply.status(201).send({
      requestId: created.id,
      payload,
      summary:
        "Sign this empty intent to let Veylo read your private balance. It moves no funds and costs nothing.",
      expiresAt: deadline,
    });
  });

  app.post("/portal/contractors/:contractorId/session-request/:id/complete", async (request) => {
    const { contractorId, id } = parse(requestParams, request.params);
    const { session, contractor } = await own(request, contractorId);
    const pending = await getContractorSessionRequest(deps.db, contractor.orgId, contractorId, id);
    if (!pending) throw notFound();
    const body = parse(signedBody, request.body);
    const now = deps.clock();
    if (pending.usedAt !== null) throw conflict("REQUEST_USED", "This request was already used");
    if (pending.expiresAt.getTime() <= now.getTime()) {
      throw conflict("REQUEST_EXPIRED", "This request has expired");
    }
    // The signer must be the account the request was made for (the one they signed in with), and
    // the key must really belong to it.
    if (body.accountId !== pending.accountId) throw rejectedSigner();
    if (body.accountId !== (await walletOf(session.userId))) throw rejectedSigner();
    let owns = false;
    try {
      owns = await isOwnerKey(deps.rpc, body.accountId, body.publicKey);
    } catch (err) {
      request.log.warn({ err }, "contractor signer key check failed");
    }
    if (!owns) throw rejectedSigner();
    const payload = {
      message: pending.message,
      nonce: pending.nonce,
      recipient: pending.recipient,
    };
    const signed = verifyNep413({
      ...payload,
      nonce: Buffer.from(pending.nonce, "base64"),
      publicKey: body.publicKey,
      signature: body.signature,
    });
    if (!signed) throw rejectedSigner();
    if (
      !(await consumeContractorSessionRequest(deps.db, contractor.orgId, contractorId, id, now))
    ) {
      throw conflict("REQUEST_USED", "This request was already used");
    }

    let tokens;
    try {
      tokens = await deps.oneclickTreasury.authenticate(toSignedData(payload, body));
    } catch (err) {
      if (err instanceof OneClickError && err.kind === "rejected") {
        throw new AppError(422, "SESSION_REJECTED", err.detail);
      }
      throw new AppError(502, "ONECLICK_UNAVAILABLE", "1Click is not available. Try again");
    }

    const orgId = contractor.orgId;
    const wrapped = await getOrCreateWrappedDataKey(deps.db, orgId, () =>
      deps.secrets.newWrappedDataKey(orgId),
    );
    const existing = await findContractorOneClickSession(deps.db, orgId, contractorId);
    const recordId = existing?.id ?? randomUUID();
    await saveContractorOneClickSession(deps.db, {
      id: recordId,
      orgId,
      contractorId,
      accountId: body.accountId,
      encryptedAccessToken: deps.secrets.encrypt(
        wrapped,
        { orgId, purpose: ACCESS, recordId },
        tokens.accessToken,
      ),
      encryptedRefreshToken: deps.secrets.encrypt(
        wrapped,
        { orgId, purpose: REFRESH, recordId },
        tokens.refreshToken,
      ),
      accessExpiresAt: new Date(now.getTime() + tokens.expiresIn * 1000),
      refreshExpiresAt: new Date(now.getTime() + tokens.refreshExpiresIn * 1000),
      status: "active",
    });
    await writeAudit(deps.db, {
      orgId,
      actor: session.userId,
      action: "contractor.session_create",
      entity: "contractor",
      entityId: contractorId,
      at: now,
    });
    return { status: "active" };
  });

  /** The contractor's private USDC balance, or the plain reason it can't be read. */
  app.get("/portal/contractors/:contractorId/balance", async (request) => {
    const { contractorId } = parse(params, request.params);
    const { contractor } = await own(request, contractorId);
    const unavailable = (reason: string) => ({
      available: false as const,
      unavailable: reason,
      source: SOURCE,
      asOf: deps.clock(),
    });
    try {
      const token = await accessToken(request.log, contractor.orgId, contractorId);
      if (token === undefined) return unavailable("needs_session");
      const { balances } = await deps.oneclickTreasury.balances(token);
      return {
        available: true as const,
        tokenId: TREASURY_ASSET_ID,
        // The docs: only non-zero balances are listed, so a missing token is a real zero.
        amount: balances.find((b) => b.tokenId === TREASURY_ASSET_ID)?.available ?? "0",
        source: SOURCE,
        asOf: deps.clock(),
      };
    } catch (err) {
      if (err instanceof OneClickError && err.kind === "unauthorized") {
        await markContractorOneClickSessionNeedsResign(deps.db, contractorId);
        return unavailable("needs_session");
      }
      request.log.warn({ err }, "contractor balance read failed");
      return unavailable("oneclick_error");
    }
  });
}
