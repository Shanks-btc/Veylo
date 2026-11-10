import { randomUUID } from "node:crypto";
import { isOwnerKey, validateAddress } from "@veylo/chains";
import {
  getFundingOrigin,
  FUNDING_ORIGIN_IDS,
  TREASURY_ASSET_ID,
  USDC,
  formatAmount,
  money,
} from "@veylo/core";
import {
  claimShieldEvent,
  consumeTreasurySessionRequest,
  findOneClickSession,
  getActiveMembershipByAccount,
  getOrCreateWrappedDataKey,
  getOrganization,
  getTreasuryEvent,
  getTreasurySessionRequest,
  insertTreasuryEvent,
  insertTreasurySessionRequest,
  markOneClickSessionNeedsResign,
  saveOneClickSession,
  updateOneClickAccessToken,
  updateTreasuryEvent,
  writeAudit,
} from "@veylo/db";
import {
  encodeVersionedNonce,
  OneClickError,
  sessionMessage,
  shieldPayloadProblem,
  toSignedData,
  verifyNep413,
} from "@veylo/intents";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, type Deps } from "./app.js";
import { AppError, conflict, notFound } from "./errors.js";
import type { Guards } from "./guards.js";
import { createSessionAccess } from "./oneclick-session.js";
import { createTreasuryLimiter } from "./rate-limit.js";

const OWNER_ONLY = ["owner"] as const;
/** Docs: recipient `intents.near`. T5b's shield payload was on it too. Salt read at runtime (L12). */
const VERIFIER = "intents.near";
const REQUEST_TTL_MS = 5 * 60 * 1000;
const QUOTE_DEADLINE_MS = 30 * 60 * 1000;
const TERMINAL = new Set(["SUCCESS", "FAILED", "REFUNDED"]);

const orgParams = z.object({ orgId: z.uuid() });
const idParams = z.object({ orgId: z.uuid(), id: z.uuid() });
const amount = z.string().regex(/^[1-9]\d{0,77}$/);
const fundingBody = z
  .object({
    originRoute: z.enum(FUNDING_ORIGIN_IDS),
    amount,
    refundAddress: z.string().max(128),
  })
  .strict();
const shieldBody = z.object({ amount: z.string().regex(/^[1-9]\d{0,18}$/) }).strict();
const signedBody = z
  .object({
    accountId: z.string().max(64),
    publicKey: z.string().max(128),
    signature: z.string().max(256),
  })
  .strict();

const rejectedSigner = () =>
  new AppError(403, "TREASURY_SIGNER_REJECTED", "Must be signed by the treasury account's wallet");

function oneClickFailure(err: unknown): never {
  if (err instanceof OneClickError) {
    if (err.kind === "rejected") throw new AppError(422, "QUOTE_REJECTED", err.detail);
    throw new AppError(502, "ONECLICK_UNAVAILABLE", "1Click is not available. Try again");
  }
  throw err;
}

const ACCESS = "oneclick.access";
const REFRESH = "oneclick.refresh";

export async function treasuryRoutes(app: FastifyInstance, deps: Deps, guards: Guards) {
  const limiter = createTreasuryLimiter({
    clock: deps.clock,
    perOrgPerHour: deps.config.treasuryLimitPerOrgPerHour ?? 60,
    perUserPerHour: deps.config.treasuryLimitPerUserPerHour ?? 30,
  });

  async function requireTreasury(orgId: string) {
    const org = await getOrganization(deps.db, orgId);
    if (!org) throw notFound();
    return org.treasuryAccountId;
  }

  /** L28: the treasury account itself, an active owner, with a key that is really its own. */
  async function assertTreasurySigner(
    log: FastifyBaseLogger,
    orgId: string,
    accountId: string,
    publicKey: string,
  ) {
    if (accountId !== (await requireTreasury(orgId))) throw rejectedSigner();
    const member = await getActiveMembershipByAccount(deps.db, orgId, accountId);
    if (member?.role !== "owner") throw rejectedSigner();
    let owns = false;
    try {
      owns = await isOwnerKey(deps.rpc, accountId, publicKey);
    } catch (err) {
      log.warn({ err }, "treasury signer key check failed");
    }
    if (!owns) throw rejectedSigner();
  }

  const audit = (orgId: string, actor: string, action: string, entityId: string, at: Date) =>
    writeAudit(deps.db, { orgId, actor, action, entity: "treasury", entityId, at });

  // --- Part C: 1Click session ---

  app.post("/orgs/:orgId/treasury/session-request", async (request, reply) => {
    const { orgId } = parse(orgParams, request.params);
    const owner = await guards.requireRole(request, orgId, OWNER_ONLY);
    limiter.check("session-request", orgId, owner.session.userId);
    const treasury = await requireTreasury(orgId);
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
      message: sessionMessage(treasury, deadline),
      nonce: encodeVersionedNonce({ saltHex, deadline, start: now, random: deps.random(7) }),
      recipient: VERIFIER,
    };
    const created = await insertTreasurySessionRequest(deps.db, {
      orgId,
      message: payload.message,
      nonce: payload.nonce,
      recipient: payload.recipient,
      expiresAt: deadline,
    });
    return reply.status(201).send({
      requestId: created.id,
      payload,
      summary:
        "Sign this empty intent to let Veylo read your confidential balance. It moves no funds.",
      expiresAt: deadline,
    });
  });

  app.post("/orgs/:orgId/treasury/session-request/:id/complete", async (request) => {
    const { orgId, id } = parse(idParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const pending = await getTreasurySessionRequest(deps.db, orgId, id);
    if (!pending) throw notFound();
    const body = parse(signedBody, request.body);
    const now = deps.clock();
    if (pending.usedAt !== null) throw conflict("REQUEST_USED", "This request was already used");
    if (pending.expiresAt.getTime() <= now.getTime()) {
      throw conflict("REQUEST_EXPIRED", "This request has expired");
    }
    await assertTreasurySigner(request.log, orgId, body.accountId, body.publicKey);
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
    if (!(await consumeTreasurySessionRequest(deps.db, orgId, id, now))) {
      throw conflict("REQUEST_USED", "This request was already used");
    }

    const tokens = await deps.oneclickTreasury
      .authenticate(toSignedData(payload, body))
      .catch(oneClickFailure);

    const wrapped = await getOrCreateWrappedDataKey(deps.db, orgId, () =>
      deps.secrets.newWrappedDataKey(orgId),
    );
    const existing = await findOneClickSession(deps.db, orgId);
    const recordId = existing?.id ?? randomUUID();
    await saveOneClickSession(deps.db, {
      id: recordId,
      orgId,
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
    await audit(orgId, session.userId, "treasury.session_create", recordId, now);
    return { status: "active" };
  });

  const { accessToken } = createSessionAccess(deps);

  // --- Part D: balances ---

  app.get("/orgs/:orgId/treasury/balances", async (request) => {
    const { orgId } = parse(orgParams, request.params);
    await guards.requireMember(request, orgId);
    const treasury = await requireTreasury(orgId);

    const publicAsOf = deps.clock();
    let publicBalance: object;
    try {
      publicBalance = {
        available: true,
        tokenId: TREASURY_ASSET_ID,
        amount: await deps.intents.mtBalanceOf(VERIFIER, treasury, TREASURY_ASSET_ID),
        source: `NEAR RPC: mt_balance_of on ${VERIFIER}`,
        asOf: publicAsOf,
      };
    } catch (err) {
      request.log.warn({ err }, "public balance read failed");
      publicBalance = {
        available: false,
        unavailable: "rpc_error",
        source: "NEAR RPC",
        asOf: publicAsOf,
      };
    }

    const SOURCE = "1Click: /v0/account/balances";
    const unavailable = (reason: string) => ({
      available: false,
      unavailable: reason,
      source: SOURCE,
      asOf: deps.clock(),
    });
    let confidential: object;
    try {
      const token = await accessToken(request.log, orgId);
      if (token === undefined) confidential = unavailable("needs_session");
      else {
        const { balances } = await deps.oneclickTreasury.balances(token);
        confidential = {
          available: true,
          tokenId: TREASURY_ASSET_ID,
          // The docs: the response lists only non-zero balances, so a missing token is a real zero.
          amount: balances.find((b) => b.tokenId === TREASURY_ASSET_ID)?.available ?? "0",
          source: SOURCE,
          asOf: deps.clock(),
        };
      }
    } catch (err) {
      if (err instanceof OneClickError && err.kind === "unauthorized") {
        await markOneClickSessionNeedsResign(deps.db, orgId);
        confidential = unavailable("needs_session");
      } else {
        request.log.warn({ err }, "confidential balance read failed");
        confidential = unavailable("oneclick_error");
      }
    }
    return { treasuryAccountId: treasury, public: publicBalance, confidential };
  });

  // --- Part F: funding ---

  app.post("/orgs/:orgId/treasury/funding-quote", async (request, reply) => {
    const { orgId } = parse(orgParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const body = parse(fundingBody, request.body);
    limiter.check("funding-quote", orgId, session.userId);
    const origin = getFundingOrigin(body.originRoute);
    const refund = validateAddress(origin.addressKind, body.refundAddress);
    if (!refund.ok) throw new AppError(400, "ADDRESS_INVALID", refund.message);

    const treasury = await requireTreasury(orgId);
    const now = deps.clock();
    const quote = await deps.oneclickTreasury
      .createFundingQuote({
        treasuryAccountId: treasury,
        recipient: treasury,
        originAsset: origin.assetId,
        amount: body.amount,
        refundAddress: refund.normalized,
        deadline: new Date(now.getTime() + QUOTE_DEADLINE_MS),
      })
      .catch(oneClickFailure);

    const event = await insertTreasuryEvent(deps.db, {
      orgId,
      type: "fund",
      originAsset: origin.assetId,
      originAmount: quote.amountIn,
      destinationAmount: BigInt(quote.amountOut),
      quote: quote.raw,
      correlationId: quote.correlationId,
      depositAddress: quote.depositAddress,
      status: "PENDING_DEPOSIT",
      statusHistory: [{ status: "PENDING_DEPOSIT", at: now.toISOString() }],
      mode: "live",
    });
    await audit(orgId, session.userId, "treasury.funding_quote", event.id, now);
    const formatted =
      (quote.raw.quote as { amountInFormatted?: string }).amountInFormatted ?? quote.amountIn;
    return reply.status(201).send({
      eventId: event.id,
      depositAddress: quote.depositAddress,
      amountToSend: quote.amountIn,
      amountToSendFormatted: formatted,
      asset: origin.symbol,
      verification: origin.verification,
      network: origin.network,
      deadline: quote.deadline,
      minimumReceived: quote.minAmountOut,
      summary: `Send exactly ${formatted} ${origin.symbol} on ${origin.network} to ${quote.depositAddress} before ${quote.deadline}. This address is single-use. Any refund goes to ${refund.normalized}.`,
    });
  });

  // --- Part G: shield ---

  app.post("/orgs/:orgId/treasury/shield-request", async (request, reply) => {
    const { orgId } = parse(orgParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const body = parse(shieldBody, request.body);
    limiter.check("shield-request", orgId, session.userId);
    const treasury = await requireTreasury(orgId);
    const now = deps.clock();

    let saltHex: string;
    try {
      saltHex = await deps.intents.currentSalt(VERIFIER);
    } catch (err) {
      request.log.warn({ err }, "could not read the verifier salt");
      throw new AppError(502, "RPC_UNAVAILABLE", "NEAR RPC is not available. Try again");
    }
    const quote = await deps.oneclickTreasury
      .createShieldQuote({
        treasuryAccountId: treasury,
        recipient: treasury,
        refundTo: treasury,
        amount: body.amount,
        deadline: new Date(now.getTime() + QUOTE_DEADLINE_MS),
      })
      .catch(oneClickFailure);
    const payload = await deps.oneclickTreasury
      .generateSwapTransferIntent({ signerId: treasury, depositAddress: quote.depositAddress })
      .catch(oneClickFailure);

    const problem = shieldPayloadProblem(payload, {
      signerId: treasury,
      depositAddress: quote.depositAddress,
      tokenId: TREASURY_ASSET_ID,
      amount: quote.amountIn,
      verifier: VERIFIER,
      saltHex,
    });
    if (problem) {
      request.log.error({ problem }, "1Click generated an unexpected shield payload");
      throw new AppError(502, "UNEXPECTED_INTENT", "1Click generated an unexpected intent");
    }

    const expiresAt = new Date(now.getTime() + QUOTE_DEADLINE_MS);
    const event = await insertTreasuryEvent(deps.db, {
      orgId,
      type: "shield",
      originAsset: TREASURY_ASSET_ID,
      originAmount: quote.amountIn,
      destinationAmount: BigInt(quote.amountOut),
      quote: quote.raw,
      correlationId: quote.correlationId,
      depositAddress: quote.depositAddress,
      status: "AWAITING_SIGNATURE",
      statusHistory: [{ status: "AWAITING_SIGNATURE", at: now.toISOString() }],
      payload,
      expiresAt,
      mode: "live",
    });
    await audit(orgId, session.userId, "treasury.shield_request", event.id, now);
    const shown = formatAmount(money(USDC, BigInt(quote.amountIn)));
    return reply.status(201).send({
      eventId: event.id,
      payload,
      amount: quote.amountIn,
      summary: `Move ${shown} USDC from your treasury's public balance into its confidential balance. Sign the raw intent your wallet shows: a transfer of ${quote.amountIn} smallest units to ${quote.depositAddress}.`,
      expiresAt,
    });
  });

  app.post("/orgs/:orgId/treasury/shield-request/:id/complete", async (request) => {
    const { orgId, id } = parse(idParams, request.params);
    const { session } = await guards.requireRole(request, orgId, OWNER_ONLY);
    const event = await getTreasuryEvent(deps.db, orgId, id);
    if (!event || event.type !== "shield") throw notFound();
    const body = parse(signedBody, request.body);
    const now = deps.clock();
    if (event.status !== "AWAITING_SIGNATURE") {
      throw conflict("REQUEST_USED", "This request was already used");
    }
    if ((event.expiresAt as Date).getTime() <= now.getTime()) {
      throw conflict("REQUEST_EXPIRED", "This request has expired");
    }
    await assertTreasurySigner(request.log, orgId, body.accountId, body.publicKey);

    const payload = event.payload as { message: string; nonce: string; recipient: string };
    const signed = verifyNep413({
      ...payload,
      nonce: Buffer.from(payload.nonce, "base64"),
      publicKey: body.publicKey,
      signature: body.signature,
    });
    // Nothing reaches 1Click unless it verifies here first.
    if (!signed) throw rejectedSigner();

    // Claimed before submitting, so one signature is never submitted twice (rule 3).
    if (!(await claimShieldEvent(deps.db, orgId, id))) {
      throw conflict("REQUEST_USED", "This request was already used");
    }
    const history = (event.statusHistory as object[]) ?? [];
    try {
      const result = await deps.oneclickTreasury.submitIntent(toSignedData(payload, body));
      await updateTreasuryEvent(deps.db, orgId, id, {
        status: "SUBMITTED",
        intentHash: result.intentHash,
        statusHistory: [...history, { status: "SUBMITTED", at: now.toISOString() }],
      });
      await audit(orgId, session.userId, "treasury.shield_submit", id, now);
      return { eventId: id, status: "SUBMITTED", intentHash: result.intentHash };
    } catch (err) {
      // The outcome may be unknown, so it's left for a status check, never re-signed (rule 3).
      await updateTreasuryEvent(deps.db, orgId, id, {
        status: "SUBMIT_UNCERTAIN",
        statusHistory: [...history, { status: "SUBMIT_UNCERTAIN", at: now.toISOString() }],
      });
      return oneClickFailure(err);
    }
  });

  // --- Status polling. No worker yet. ---

  app.post("/orgs/:orgId/treasury/events/:id/refresh", async (request) => {
    const { orgId, id } = parse(idParams, request.params);
    await guards.requireRole(request, orgId, OWNER_ONLY);
    const event = await getTreasuryEvent(deps.db, orgId, id);
    if (!event) throw notFound();
    const history = (event.statusHistory as { status: string; at: string }[]) ?? [];
    if (TERMINAL.has(event.status) || event.status === "AWAITING_SIGNATURE") {
      return { eventId: id, status: event.status, statusHistory: history };
    }
    const observed = await deps.oneclickTreasury
      .status(event.depositAddress)
      .catch(oneClickFailure);
    const now = deps.clock();
    const next =
      history.at(-1)?.status === observed.status
        ? history
        : [...history, { status: observed.status, at: now.toISOString() }];
    await updateTreasuryEvent(deps.db, orgId, id, {
      status: observed.status,
      statusHistory: next,
      lastStatus: observed,
    });
    return { eventId: id, status: observed.status, statusHistory: next };
  });
}
