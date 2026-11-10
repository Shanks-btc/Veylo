import { isOwnerKey, validateNearAccountId } from "@veylo/chains";
import {
  consumeChallenge,
  deleteExpiredChallenges,
  findChallenge,
  findOrCreateUser,
  insertChallenge,
  insertSession,
  listActiveMembershipsForUser,
  revokeSession,
  writeAudit,
} from "@veylo/db";
import { NEP413_NONCE_BYTES, verifyNep413 } from "@veylo/intents";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, sha256Hex, type Deps } from "./app.js";
import { authFailed } from "./errors.js";
import { SESSION_COOKIE, type Guards } from "./guards.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** NEAR's account ID rules. They also keep line breaks out of the signed message. */
export const nearAccountId = z.string().refine((id) => validateNearAccountId(id).ok);

const challengeBody = z.object({ accountId: nearAccountId }).strict();
const verifyBody = z
  .object({
    accountId: nearAccountId,
    publicKey: z.string().max(128),
    signature: z.string().max(256),
    nonce: z.string().max(64),
  })
  .strict();

function secureCookie(webOrigin: string): boolean {
  const { hostname } = new URL(webOrigin);
  return hostname !== "localhost" && hostname !== "127.0.0.1";
}

export async function authRoutes(app: FastifyInstance, deps: Deps, guards: Guards) {
  const limited = {
    config: { rateLimit: { max: deps.authRateLimitPerMinute ?? 30, timeWindow: 60_000 } },
  };

  app.post("/auth/challenge", limited, async (request) => {
    const { accountId } = parse(challengeBody, request.body);
    const nonce = Buffer.from(deps.random(NEP413_NONCE_BYTES));
    const issued = deps.clock();
    const expires = new Date(issued.getTime() + CHALLENGE_TTL_MS);
    const message = [
      "Sign in to Veylo",
      `Account: ${accountId}`,
      `Nonce: ${nonce.toString("hex")}`,
      `Issued: ${issued.toISOString()}`,
      `Expires: ${expires.toISOString()}`,
    ].join("\n");
    const encoded = nonce.toString("base64");
    await insertChallenge(deps.db, { nonce: encoded, accountId, message, expiresAt: expires });
    try {
      await deleteExpiredChallenges(deps.db, new Date(issued.getTime() - CHALLENGE_RETENTION_MS));
    } catch (err) {
      // Housekeeping must not block a sign-in.
      request.log.warn({ err }, "challenge cleanup failed");
    }
    return { message, nonce: encoded, recipient: deps.config.authRecipient };
  });

  app.post("/auth/verify", limited, async (request, reply) => {
    const body = verifyBody.safeParse(request.body);
    if (!body.success) throw authFailed();
    const { accountId, publicKey, signature, nonce } = body.data;
    const now = deps.clock();

    const challenge = await findChallenge(deps.db, nonce);
    if (
      !challenge ||
      challenge.accountId !== accountId ||
      challenge.usedAt !== null ||
      challenge.expiresAt.getTime() <= now.getTime()
    ) {
      throw authFailed();
    }

    const signed = verifyNep413({
      message: challenge.message,
      nonce: Buffer.from(nonce, "base64"),
      recipient: deps.config.authRecipient,
      publicKey,
      signature,
    });
    if (!signed) throw authFailed();

    let owner = false;
    try {
      owner = await isOwnerKey(deps.rpc, accountId, publicKey);
    } catch (err) {
      request.log.warn({ err }, "key ownership check failed");
    }
    if (!owner) throw authFailed();

    const token = Buffer.from(deps.random(32)).toString("base64url");
    const ttlSeconds = deps.config.sessionTtlHours * 3600;
    await deps.db.transaction(async (tx) => {
      // The earlier read is only a fast path. This is what stops a double spend.
      const spent = await consumeChallenge(tx, { nonce, accountId, now });
      if (!spent) throw authFailed();
      const user = await findOrCreateUser(tx, accountId);
      const sessionId = await insertSession(tx, {
        tokenHash: sha256Hex(token),
        userId: user.id,
        createdAt: now,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      });
      await writeAudit(tx, {
        orgId: null,
        actor: user.id,
        action: "auth.sign_in",
        entity: "session",
        entityId: sessionId,
        at: now,
      });
    });

    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secureCookie(deps.config.webOrigin),
      sameSite: "lax",
      path: "/",
      maxAge: ttlSeconds,
    });
    return { accountId };
  });

  app.post("/auth/logout", limited, async (request, reply) => {
    const session = await guards.requireSession(request);
    const now = deps.clock();
    await deps.db.transaction(async (tx) => {
      await revokeSession(tx, session.sessionId, now);
      await writeAudit(tx, {
        orgId: null,
        actor: session.userId,
        action: "auth.logout",
        entity: "session",
        entityId: session.sessionId,
        at: now,
      });
    });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (request) => {
    const session = await guards.requireSession(request);
    return {
      user: { id: session.userId, nearAccountId: session.nearAccountId },
      memberships: await listActiveMembershipsForUser(deps.db, session.userId),
    };
  });
}
