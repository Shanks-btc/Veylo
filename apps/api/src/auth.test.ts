import { PAYOUT_ROUTE_IDS } from "@veylo/core";
import { createHash } from "node:crypto";
import { schema } from "@veylo/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  challenge,
  createHarness,
  namedWallet,
  RECIPIENT,
  sessionCookie,
  signIn,
  verify,
  Wallet,
  type App,
} from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

const GENERIC = { error: { code: "AUTH_FAILED", message: "Authentication failed" } };

function expectGeneric(res: { statusCode: number; json: () => unknown; cookies: unknown[] }) {
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual(GENERIC);
  expect(res.cookies).toEqual([]);
}

const FUNCTION_CALL = { FunctionCall: { allowance: null, method_names: [], receiver_id: "x" } };

describe("POST /auth/challenge", () => {
  it("returns the plain-text message, a 32-byte nonce and the recipient", async () => {
    const res = await challenge(app, "alice.near");
    const nonce = Buffer.from(res.nonce, "base64");
    expect(nonce.length).toBe(32);
    expect(res.recipient).toBe(RECIPIENT);
    expect(res.message).toBe(
      [
        "Sign in to Veylo",
        "Account: alice.near",
        `Nonce: ${nonce.toString("hex")}`,
        `Issued: ${h.clock.now.toISOString()}`,
        `Expires: ${new Date(h.clock.now.getTime() + 300_000).toISOString()}`,
      ].join("\n"),
    );
  });

  it.each([
    ["line breaks that would forge message lines", "a.near\nAccount: b.near"],
    ["upper case", "Alice.near"],
    ["too short", "a"],
    ["too long", `${"a".repeat(65)}`],
  ])("rejects an account ID with %s", async (_name, accountId) => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { accountId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_REQUEST");
  });

  it("rejects extra fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { accountId: "a.near", extra: 1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /auth/verify success", () => {
  it("never-funded implicit account: signs in on derivation, creating the user", async () => {
    const wallet = new Wallet();
    const res = await verify(app, wallet, await challenge(app, wallet.accountId));
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/me", cookies: sessionCookie(res) });
    expect(me.json()).toMatchObject({
      user: { nearAccountId: wallet.accountId },
      memberships: [],
    });
  });

  it("named account: accepts a FullAccess key", async () => {
    const wallet = namedWallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, "FullAccess"]]));
    const res = await verify(app, wallet, await challenge(app, wallet.accountId));
    expect(res.statusCode).toBe(200);
  });

  it("a second sign-in reuses the user", async () => {
    const wallet = new Wallet();
    await signIn(app, wallet);
    await signIn(app, wallet);
    const rows = await h.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.nearAccountId, wallet.accountId));
    expect(rows).toHaveLength(1);
  });

  it("sets an httpOnly, Secure, SameSite=Lax cookie holding a 32-byte token", async () => {
    const wallet = new Wallet();
    const res = await verify(app, wallet, await challenge(app, wallet.accountId));
    const cookie = res.cookies[0] as Record<string, unknown>;
    expect(cookie).toMatchObject({
      name: "veylo_session",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 24 * 3600,
    });
    expect(Buffer.from(cookie.value as string, "base64url").length).toBe(32);
  });

  it("omits Secure only on localhost", async () => {
    const base = await h.build();
    await base.close();
    const local = await h.build({
      config: {
        // Tests keep every payout route covered (L46).
        enabledPayoutRoutes: PAYOUT_ROUTE_IDS,
        authRecipient: RECIPIENT,
        webOrigin: "http://localhost:3000",
        sessionTtlHours: 24,
        logLevel: "silent",
      },
    });
    const wallet = new Wallet();
    const res = await verify(local, wallet, await challenge(local, wallet.accountId));
    expect((res.cookies[0] as { secure?: boolean }).secure).toBeUndefined();
    await local.close();
  });

  it("stores only the SHA-256 of the token", async () => {
    const wallet = new Wallet();
    const res = await verify(app, wallet, await challenge(app, wallet.accountId));
    const token = Object.values(sessionCookie(res))[0] as string;
    const hash = createHash("sha256").update(token).digest("hex");
    const rows = await h.db.select().from(schema.sessions);
    expect(rows.filter((r) => r.tokenHash === hash)).toHaveLength(1);
    expect(rows.filter((r) => r.tokenHash === token)).toHaveLength(0);
  });
});

describe("POST /auth/verify rejections", () => {
  it("challenge replay", async () => {
    const wallet = new Wallet();
    const c = await challenge(app, wallet.accountId);
    expect((await verify(app, wallet, c)).statusCode).toBe(200);
    expectGeneric(await verify(app, wallet, c));
  });

  it("an expired challenge, including at the exact expiry moment", async () => {
    const wallet = new Wallet();
    const c = await challenge(app, wallet.accountId);
    const start = h.clock.now;
    h.clock.now = new Date(start.getTime() + 300_000);
    expectGeneric(await verify(app, wallet, c));
    h.clock.now = start;
  });

  it("still accepts one millisecond before expiry", async () => {
    const wallet = new Wallet();
    const c = await challenge(app, wallet.accountId);
    const start = h.clock.now;
    h.clock.now = new Date(start.getTime() + 299_999);
    expect((await verify(app, wallet, c)).statusCode).toBe(200);
    h.clock.now = start;
  });

  it("a mismatched account: B signing A's challenge", async () => {
    const a = new Wallet();
    const b = new Wallet();
    expectGeneric(await verify(app, b, await challenge(app, a.accountId)));
  });

  it("a function-call-only key on a named account", async () => {
    const wallet = namedWallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, FUNCTION_CALL]]));
    expectGeneric(await verify(app, wallet, await challenge(app, wallet.accountId)));
  });

  it("a key not on the named account", async () => {
    const wallet = namedWallet();
    expectGeneric(await verify(app, wallet, await challenge(app, wallet.accountId)));
  });

  it("a wrong key for an implicit account", async () => {
    const victim = new Wallet();
    const attacker = new Wallet(victim.accountId);
    expectGeneric(await verify(app, attacker, await challenge(app, victim.accountId)));
  });

  it("an RPC failure fails closed", async () => {
    const wallet = namedWallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, "FullAccess"]]));
    const c = await challenge(app, wallet.accountId);
    h.rpcHooks.fail = true;
    expectGeneric(await verify(app, wallet, c));
    h.rpcHooks.fail = false;
  });

  it("a signature over another recipient", async () => {
    const wallet = new Wallet();
    const c = await challenge(app, wallet.accountId);
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        accountId: wallet.accountId,
        publicKey: wallet.publicKey,
        signature: wallet.sign(c.message, c.nonce, "intents.near"),
        nonce: c.nonce,
      },
    });
    expectGeneric(res);
  });

  it("a signature over another message", async () => {
    const wallet = new Wallet();
    const c = await challenge(app, wallet.accountId);
    expectGeneric(await verify(app, wallet, { message: `${c.message}!`, nonce: c.nonce }));
  });

  it("an unknown nonce and malformed bodies", async () => {
    const wallet = new Wallet();
    const nonce = Buffer.alloc(32, 1).toString("base64");
    expectGeneric(await verify(app, wallet, { message: "m", nonce }));
    for (const payload of [{}, { accountId: "a.near" }, { nonce: 1 }]) {
      expectGeneric(await app.inject({ method: "POST", url: "/auth/verify", payload }));
    }
  });

  it("a failed attempt doesn't spend the challenge", async () => {
    const wallet = new Wallet();
    const c = await challenge(app, wallet.accountId);
    expectGeneric(await verify(app, wallet, { message: `${c.message}!`, nonce: c.nonce }));
    expect((await verify(app, wallet, c)).statusCode).toBe(200);
  });
});

describe("implicit accounts that exist on-chain", () => {
  it("accepts a key that is still FullAccess", async () => {
    const wallet = new Wallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, "FullAccess"]]));
    const res = await verify(app, wallet, await challenge(app, wallet.accountId));
    expect(res.statusCode).toBe(200);
  });

  it("rejects the deriving key once it has been rotated out", async () => {
    const wallet = new Wallet();
    h.chain.set(wallet.accountId, new Map([["ed25519:replacement", "FullAccess"]]));
    expectGeneric(await verify(app, wallet, await challenge(app, wallet.accountId)));
  });

  it("rejects a deriving key reduced to function-call", async () => {
    const wallet = new Wallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, FUNCTION_CALL]]));
    expectGeneric(await verify(app, wallet, await challenge(app, wallet.accountId)));
  });

  it("fails closed if RPC is down", async () => {
    const wallet = new Wallet();
    const c = await challenge(app, wallet.accountId);
    h.rpcHooks.fail = true;
    expectGeneric(await verify(app, wallet, c));
    h.rpcHooks.fail = false;
  });
});

describe("challenge cleanup", () => {
  const seed = (nonce: string, expiresAt: Date) => ({
    nonce,
    accountId: "old.near",
    message: "m",
    expiresAt,
  });
  const issue = () => challenge(app, "cleanup.near");
  const nonces = async (prefix: string) =>
    (await h.db.select().from(schema.authChallenges))
      .map((r) => r.nonce)
      .filter((n) => n.startsWith(prefix));
  const ago = (ms: number) => new Date(h.clock.now.getTime() - ms);
  const DAY = 24 * 3600 * 1000;

  it("deletes only challenges expired for over 24 hours", async () => {
    await h.db
      .insert(schema.authChallenges)
      .values([
        seed("keep-a-old-enough-not", ago(DAY)),
        seed("keep-b-recently-expired", ago(1000)),
        seed("keep-c-still-valid", ago(-1000)),
        seed("gone-a", ago(DAY + 1)),
      ]);
    await issue();
    expect(await nonces("gone-")).toEqual([]);
    expect((await nonces("keep-")).sort()).toEqual([
      "keep-a-old-enough-not",
      "keep-b-recently-expired",
      "keep-c-still-valid",
    ]);
  });

  it("deletes at most 500 per challenge issued, oldest first", async () => {
    const rows = Array.from({ length: 502 }, (_, i) =>
      seed(`batch-${i}`, ago(DAY + 1000 + (502 - i))),
    );
    await h.db.insert(schema.authChallenges).values(rows);
    await issue();
    expect((await nonces("batch-")).sort()).toEqual(["batch-500", "batch-501"]);
    await issue();
    expect(await nonces("batch-")).toEqual([]);
  });
});

describe("concurrent double-verify of one challenge", () => {
  it("creates exactly one session", async () => {
    const wallet = namedWallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, "FullAccess"]]));
    const c = await challenge(app, wallet.accountId);

    // Hold both requests at the RPC call until both have read the challenge as unused.
    let arrived = 0;
    let release: () => void = () => {};
    const bothThere = new Promise<void>((resolve) => (release = resolve));
    h.rpcHooks.before = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await bothThere;
    };
    const results = await Promise.all([verify(app, wallet, c), verify(app, wallet, c)]);
    h.rpcHooks.before = undefined;

    expect(arrived).toBe(2);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const [user] = await h.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.nearAccountId, wallet.accountId));
    const sessions = await h.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user?.id as string));
    expect(sessions).toHaveLength(1);
  });
});

describe("sessions", () => {
  it("/me requires a session", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects an unknown token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      cookies: { veylo_session: "nope" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("logout revokes the session on the server", async () => {
    const { cookies } = await signIn(app);
    const out = await app.inject({ method: "POST", url: "/auth/logout", cookies });
    expect(out.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/me", cookies });
    expect(me.statusCode).toBe(401);
  });

  it("logout requires a session", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/logout" });
    expect(res.statusCode).toBe(401);
  });

  it("expires after the TTL", async () => {
    const { cookies } = await signIn(app);
    const start = h.clock.now;
    h.clock.now = new Date(start.getTime() + 24 * 3600 * 1000);
    const me = await app.inject({ method: "GET", url: "/me", cookies });
    h.clock.now = start;
    expect(me.statusCode).toBe(401);
  });
});

describe("audit log", () => {
  it("records sign-in and logout, with no token or signature", async () => {
    const { cookies, wallet } = await signIn(app);
    const session = await app.inject({ method: "GET", url: "/me", cookies });
    const userId = session.json().user.id as string;
    await app.inject({ method: "POST", url: "/auth/logout", cookies });
    const rows = await h.db.select().from(schema.auditLog).where(eq(schema.auditLog.actor, userId));
    expect(rows.map((r) => r.action).sort()).toEqual(["auth.logout", "auth.sign_in"]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(Object.values(cookies)[0]);
    expect(text).not.toContain(wallet.publicKey);
  });
});
