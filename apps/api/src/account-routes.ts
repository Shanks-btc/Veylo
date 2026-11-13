// Email accounts (slice W6): sign up, sign in, verify the address, reset or change the password, and
// link a wallet to the account by a signature. The email account is for sign-in, invites and
// notices. It carries no signing power: every approval and payout still needs the treasury wallet's
// signature, checked in the browser. The wallet key is created and kept in the wallet bridge origin
// and never reaches this API; this password is never the wallet password and unlocks nothing there.
import { isOwnerKey } from "@veylo/chains";
import {
  clearLoginFailures,
  consumeChallenge,
  consumeEmailToken,
  createEmailUser,
  findChallenge,
  findUserByEmail,
  getUser,
  insertChallenge,
  insertEmailToken,
  insertOutboxEmail,
  insertSession,
  invalidateEmailTokens,
  linkWalletToUser,
  markEmailVerified,
  recordLoginFailure,
  revokeAllSessions,
  setPasswordHash,
  writeAudit,
  type Db,
} from "@veylo/db";
import { resetPasswordMessage, verifyEmailMessage } from "@veylo/core";
import { NEP413_NONCE_BYTES, verifyNep413 } from "@veylo/intents";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, sha256Hex, type Deps } from "./app.js";
import { nearAccountId, secureCookie } from "./auth-routes.js";
import { AppError, authFailed, conflict } from "./errors.js";
import { SESSION_COOKIE, type Guards } from "./guards.js";
import { DUMMY_PHC, hashPassword, passwordProblem, verifyPassword } from "./passwords.js";

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const LINK_TTL_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

export const LINK_FIRST_LINE = "Link this wallet to Veylo";

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/);
const password = z.string().min(1).max(256);
const token = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);

const signupBody = z.object({ email, password }).strict();
const loginBody = z.object({ email, password }).strict();
const tokenBody = z.object({ token }).strict();
const forgotBody = z.object({ email }).strict();
const resetBody = z.object({ token, password }).strict();
const changeBody = z.object({ currentPassword: password, newPassword: password }).strict();
const linkChallengeBody = z.object({ accountId: nearAccountId }).strict();
const linkBody = z
  .object({
    accountId: nearAccountId,
    publicKey: z.string().max(128),
    signature: z.string().max(256),
    nonce: z.string().max(64),
  })
  .strict();

const weakPassword = (message: string) => new AppError(422, "WEAK_PASSWORD", message);

export async function accountRoutes(app: FastifyInstance, deps: Deps, guards: Guards) {
  const strict = {
    config: { rateLimit: { max: deps.authRateLimitPerMinute ?? 10, timeWindow: 60_000 } },
  };
  const web = deps.config.webOrigin;
  const newToken = () => Buffer.from(deps.random(32)).toString("base64url");

  async function startSession(tx: Db, userId: string, now: Date) {
    const raw = newToken();
    const ttlSeconds = deps.config.sessionTtlHours * 3600;
    const sessionId = await insertSession(tx, {
      tokenHash: sha256Hex(raw),
      userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    });
    return { raw, sessionId, ttlSeconds };
  }

  async function sendVerification(db: Db, userId: string, to: string, now: Date) {
    await invalidateEmailTokens(db, userId, "verify", now);
    const raw = newToken();
    await insertEmailToken(db, {
      userId,
      purpose: "verify",
      tokenHash: sha256Hex(raw),
      expiresAt: new Date(now.getTime() + VERIFY_TTL_MS),
    });
    const msg = verifyEmailMessage({ link: `${web}/app/verify-email?token=${raw}` });
    await insertOutboxEmail(db, { toEmail: to, kind: "verify", ...msg });
  }

  app.post("/auth/signup", strict, async (request, reply) => {
    const body = parse(signupBody, request.body);
    const problem = passwordProblem(body.password, body.email);
    if (problem) throw weakPassword(problem);
    const now = deps.clock();
    const passwordHash = await hashPassword(body.password, deps.random);
    const result = await deps.db.transaction(async (tx) => {
      const user = await createEmailUser(tx, { email: body.email, passwordHash });
      if (!user)
        throw conflict("EMAIL_TAKEN", "That email already has an account. Sign in instead.");
      await sendVerification(tx, user.id, body.email, now);
      const session = await startSession(tx, user.id, now);
      await writeAudit(tx, {
        orgId: null,
        actor: user.id,
        action: "auth.sign_up",
        entity: "user",
        entityId: user.id,
        at: now,
      });
      return { user, session };
    });
    reply.setCookie(SESSION_COOKIE, result.session.raw, {
      httpOnly: true,
      secure: secureCookie(web),
      sameSite: "lax",
      path: "/",
      maxAge: result.session.ttlSeconds,
    });
    return reply.status(201).send({ email: body.email, emailVerified: false });
  });

  app.post("/auth/login", strict, async (request, reply) => {
    const body = parse(loginBody, request.body);
    const now = deps.clock();
    const user = await findUserByEmail(deps.db, body.email);
    // Always spend the same work, so response time doesn't say whether the account exists.
    const locked = user?.lockedUntil && user.lockedUntil.getTime() > now.getTime();
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_PHC);
    if (!user || !user.passwordHash || locked || !ok) {
      if (user && !locked) {
        await recordLoginFailure(deps.db, user.id, {
          now,
          maxFailures: MAX_FAILURES,
          lockMs: LOCK_MS,
        });
      }
      throw authFailed();
    }
    const session = await deps.db.transaction(async (tx) => {
      await clearLoginFailures(tx, user.id);
      const s = await startSession(tx, user.id, now);
      await writeAudit(tx, {
        orgId: null,
        actor: user.id,
        action: "auth.email_sign_in",
        entity: "session",
        entityId: s.sessionId,
        at: now,
      });
      return s;
    });
    reply.setCookie(SESSION_COOKIE, session.raw, {
      httpOnly: true,
      secure: secureCookie(web),
      sameSite: "lax",
      path: "/",
      maxAge: session.ttlSeconds,
    });
    return { email: user.email, emailVerified: user.emailVerifiedAt !== null };
  });

  app.post("/auth/verify-email", strict, async (request) => {
    const { token: raw } = parse(tokenBody, request.body);
    const now = deps.clock();
    const spent = await consumeEmailToken(deps.db, {
      tokenHash: sha256Hex(raw),
      purpose: "verify",
      now,
    });
    if (!spent)
      throw new AppError(400, "LINK_INVALID", "This link has expired or was already used.");
    await markEmailVerified(deps.db, spent.userId, now);
    return { ok: true };
  });

  app.post("/auth/resend-verification", strict, async (request) => {
    const session = await guards.requireSession(request);
    const user = await getUser(deps.db, session.userId);
    if (!user?.email) throw new AppError(400, "NO_EMAIL", "This account has no email address.");
    if (user.emailVerifiedAt) return { ok: true };
    await sendVerification(deps.db, user.id, user.email, deps.clock());
    return { ok: true };
  });

  // Always the same answer, so the form can't be used to find out who has an account.
  app.post("/auth/forgot-password", strict, async (request) => {
    const { email: address } = parse(forgotBody, request.body);
    const user = await findUserByEmail(deps.db, address);
    if (user?.email && user.passwordHash) {
      const now = deps.clock();
      await invalidateEmailTokens(deps.db, user.id, "reset", now);
      const raw = newToken();
      await insertEmailToken(deps.db, {
        userId: user.id,
        purpose: "reset",
        tokenHash: sha256Hex(raw),
        expiresAt: new Date(now.getTime() + RESET_TTL_MS),
      });
      const msg = resetPasswordMessage({ link: `${web}/app/reset-password?token=${raw}` });
      await insertOutboxEmail(deps.db, { toEmail: user.email, kind: "reset", ...msg });
    }
    return { ok: true };
  });

  app.post("/auth/reset-password", strict, async (request) => {
    const body = parse(resetBody, request.body);
    const now = deps.clock();
    // The weak-password check runs before the token is spent, so a typo doesn't burn the link.
    const problem = passwordProblem(body.password, "");
    if (problem) throw weakPassword(problem);
    const hash = await hashPassword(body.password, deps.random);
    const spent = await consumeEmailToken(deps.db, {
      tokenHash: sha256Hex(body.token),
      purpose: "reset",
      now,
    });
    if (!spent)
      throw new AppError(400, "LINK_INVALID", "This link has expired or was already used.");
    await deps.db.transaction(async (tx) => {
      await setPasswordHash(tx, spent.userId, hash);
      // Everyone who was signed in is signed out: whoever knew the old password is out.
      await revokeAllSessions(tx, spent.userId, now);
      await writeAudit(tx, {
        orgId: null,
        actor: spent.userId,
        action: "auth.password_reset",
        entity: "user",
        entityId: spent.userId,
        at: now,
      });
    });
    // Resetting a password never touches a wallet: there is nothing here that could.
    return { ok: true };
  });

  app.post("/auth/change-password", strict, async (request) => {
    const session = await guards.requireSession(request);
    const body = parse(changeBody, request.body);
    const user = await getUser(deps.db, session.userId);
    if (!user?.passwordHash || !user.email)
      throw new AppError(400, "NO_PASSWORD", "This account signs in with a wallet.");
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) throw authFailed();
    const problem = passwordProblem(body.newPassword, user.email);
    if (problem) throw weakPassword(problem);
    const hash = await hashPassword(body.newPassword, deps.random);
    const now = deps.clock();
    await deps.db.transaction(async (tx) => {
      await setPasswordHash(tx, user.id, hash);
      await revokeAllSessions(tx, user.id, now);
      await writeAudit(tx, {
        orgId: null,
        actor: user.id,
        action: "auth.password_change",
        entity: "user",
        entityId: user.id,
        at: now,
      });
    });
    return { ok: true };
  });

  // --- Linking a wallet to an email account: proof by a NEP-413 signature, over its own message. ---

  app.post("/auth/wallet-link/challenge", strict, async (request) => {
    const session = await guards.requireSession(request);
    const { accountId } = parse(linkChallengeBody, request.body);
    const nonce = Buffer.from(deps.random(NEP413_NONCE_BYTES));
    const issued = deps.clock();
    const expires = new Date(issued.getTime() + LINK_TTL_MS);
    const message = [
      LINK_FIRST_LINE,
      `Account: ${accountId}`,
      `User: ${session.userId}`,
      `Nonce: ${nonce.toString("hex")}`,
      `Issued: ${issued.toISOString()}`,
      `Expires: ${expires.toISOString()}`,
    ].join("\n");
    const encoded = nonce.toString("base64");
    await insertChallenge(deps.db, { nonce: encoded, accountId, message, expiresAt: expires });
    return { message, nonce: encoded, recipient: deps.config.authRecipient };
  });

  app.post("/auth/wallet-link", strict, async (request) => {
    const session = await guards.requireSession(request);
    const body = parse(linkBody, request.body);
    const now = deps.clock();
    const challenge = await findChallenge(deps.db, body.nonce);
    if (
      !challenge ||
      challenge.accountId !== body.accountId ||
      challenge.usedAt !== null ||
      challenge.expiresAt.getTime() <= now.getTime() ||
      !challenge.message.startsWith(`${LINK_FIRST_LINE}\n`) ||
      !challenge.message.includes(`\nUser: ${session.userId}\n`)
    ) {
      throw authFailed();
    }
    const signed = verifyNep413({
      message: challenge.message,
      nonce: Buffer.from(body.nonce, "base64"),
      recipient: deps.config.authRecipient,
      publicKey: body.publicKey,
      signature: body.signature,
    });
    if (!signed) throw authFailed();
    let owner = false;
    try {
      owner = await isOwnerKey(deps.rpc, body.accountId, body.publicKey);
    } catch (err) {
      request.log.warn({ err }, "key ownership check failed");
    }
    if (!owner) throw authFailed();
    await deps.db.transaction(async (tx) => {
      const spent = await consumeChallenge(tx, {
        nonce: body.nonce,
        accountId: body.accountId,
        now,
      });
      if (!spent) throw authFailed();
      const linked = await linkWalletToUser(tx, session.userId, body.accountId);
      if (!linked)
        throw conflict("WALLET_TAKEN", "That wallet is already linked to another account.");
      await writeAudit(tx, {
        orgId: null,
        actor: session.userId,
        action: "auth.wallet_link",
        entity: "user",
        entityId: session.userId,
        at: now,
      });
    });
    return { accountId: body.accountId };
  });
}
