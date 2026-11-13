// Email accounts (slice W6): sign up, verify, sign in, lock out, reset, change, and link a wallet.
// The email account is for sign-in and notices. It gives no signing power and never touches a wallet.
import { listOutboxFor, schema } from "@veylo/db";
import { WALLET_NOT_RESTORED } from "@veylo/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "./guards.js";
import { ARGON2_PARAMS, passwordProblem } from "./passwords.js";
import {
  createHarness,
  createOrg,
  RECIPIENT,
  sessionCookie,
  signIn,
  Wallet,
  type App,
} from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
beforeAll(async () => {
  h = await createHarness();
  app = await h.build({ authRateLimitPerMinute: 1000 });
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

const PASSWORD = "a long enough passphrase";
let n = 0;
const fresh = () => `person${(n += 1)}-${Date.now()}@example.test`;

const post = (url: string, payload: object, cookies?: Record<string, string>) =>
  app.inject({ method: "POST", url, payload, ...(cookies ? { cookies } : {}) });

async function signUp(email = fresh(), password = PASSWORD) {
  const res = await post("/auth/signup", { email, password });
  return { email, res, cookies: res.statusCode === 201 ? sessionCookie(res) : undefined };
}

const outbox = (email: string) => listOutboxFor(h.db, email);
const linkIn = (body: string) => /(https?:\/\/\S+token=([A-Za-z0-9_-]+))/.exec(body)?.[2] ?? "";

describe("sign up", () => {
  it("creates an account, signs the person in and queues one verification email", async () => {
    const { email, res, cookies } = await signUp();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ email, emailVerified: false });
    const me = await app.inject({ method: "GET", url: "/me", cookies });
    expect(me.json().user).toMatchObject({ nearAccountId: null, email, emailVerified: false });
    const mails = await outbox(email);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.kind).toBe("verify");
    expect(linkIn(mails[0]?.body ?? "")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("treats the address case-insensitively and refuses a second account", async () => {
    const email = fresh();
    expect((await signUp(email)).res.statusCode).toBe(201);
    const again = await signUp(email.toUpperCase());
    expect(again.res.statusCode).toBe(409);
    expect(again.res.json().error.code).toBe("EMAIL_TAKEN");
  });

  it("refuses a weak password with a reason in plain words", async () => {
    for (const bad of ["short", "password123", "aaaaaaaaaaaa"]) {
      const { res } = await signUp(fresh(), bad);
      expect(res.statusCode, bad).toBe(422);
      expect(res.json().error.code).toBe("WEAK_PASSWORD");
      expect(res.json().error.message.length).toBeGreaterThan(10);
    }
    const email = "ada.lovelace@example.test";
    expect(passwordProblem("ada.lovelace-and-more", email)).toMatch(/email/);
  });

  it("stores an Argon2id hash with the documented cost, never the password", async () => {
    const { email } = await signUp(fresh(), "my unique passphrase 1");
    const [row] = await h.db.select().from(schema.users).where(eq(schema.users.email, email));
    expect(row?.passwordHash).toMatch(
      new RegExp(
        `^\\$argon2id\\$v=19\\$m=${ARGON2_PARAMS.m},t=${ARGON2_PARAMS.t},p=${ARGON2_PARAMS.p}\\$`,
      ),
    );
    expect(row?.passwordHash).not.toContain("unique");
    const audit = JSON.stringify(await h.db.select().from(schema.auditLog));
    expect(audit).not.toContain("my unique passphrase");
  });

  it("rejects a malformed address and extra fields", async () => {
    expect(
      (await post("/auth/signup", { email: "not-an-email", password: PASSWORD })).statusCode,
    ).toBe(400);
    expect(
      (await post("/auth/signup", { email: fresh(), password: PASSWORD, admin: true })).statusCode,
    ).toBe(400);
  });
});

describe("verify the address", () => {
  it("a verification link works once and flips emailVerified", async () => {
    const { email, cookies } = await signUp();
    const token = linkIn((await outbox(email))[0]?.body ?? "");
    expect((await post("/auth/verify-email", { token })).statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/me", cookies });
    expect(me.json().user.emailVerified).toBe(true);
    const again = await post("/auth/verify-email", { token });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe("LINK_INVALID");
  });

  it("an expired link is refused, and resending makes a new one that replaces the old", async () => {
    const { email, cookies } = await signUp();
    const first = linkIn((await outbox(email))[0]?.body ?? "");
    await post("/auth/resend-verification", {}, cookies);
    const mails = await outbox(email);
    expect(mails).toHaveLength(2);
    const second = linkIn(mails[0]?.body ?? "");
    expect(second).not.toBe(first);
    expect((await post("/auth/verify-email", { token: first })).statusCode).toBe(400);
    const was = h.clock.now;
    h.clock.now = new Date(was.getTime() + 25 * 3600_000);
    expect((await post("/auth/verify-email", { token: second })).statusCode).toBe(400);
    h.clock.now = was;
  });

  it("refuses a made-up token", async () => {
    expect((await post("/auth/verify-email", { token: "x".repeat(43) })).statusCode).toBe(400);
  });
});

describe("sign in", () => {
  it("signs in with the right password and sets an httpOnly cookie", async () => {
    const { email } = await signUp();
    const res = await post("/auth/login", { email: email.toUpperCase(), password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
  });

  it("gives the same answer for a wrong password and an unknown address", async () => {
    const { email } = await signUp();
    const wrong = await post("/auth/login", { email, password: "not the password at all" });
    const unknown = await post("/auth/login", {
      email: fresh(),
      password: "not the password at all",
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("locks the account for 15 minutes after five wrong tries, even for the right password", async () => {
    const { email } = await signUp();
    for (let i = 0; i < 5; i += 1)
      expect((await post("/auth/login", { email, password: "wrong wrong wrong" })).statusCode).toBe(
        401,
      );
    expect((await post("/auth/login", { email, password: PASSWORD })).statusCode).toBe(401);
    const was = h.clock.now;
    h.clock.now = new Date(was.getTime() + 16 * 60_000);
    expect((await post("/auth/login", { email, password: PASSWORD })).statusCode).toBe(200);
    h.clock.now = was;
  });

  it("an email account cannot sign anything: it has no wallet, so no organisation yet", async () => {
    const { cookies } = await signUp();
    const res = await post("/orgs", { name: "No wallet yet" }, cookies);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("WALLET_REQUIRED");
  });
});

describe("forgot and reset the password", () => {
  it("answers the same for a known and an unknown address, and only mails the known one", async () => {
    const { email } = await signUp();
    const unknown = fresh();
    const a = await post("/auth/forgot-password", { email });
    const b = await post("/auth/forgot-password", { email: unknown });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual(b.json());
    expect((await outbox(email)).some((m) => m.kind === "reset")).toBe(true);
    expect(await outbox(unknown)).toHaveLength(0);
  });

  it("the reset mail says plainly that it does not restore a wallet", async () => {
    const { email } = await signUp();
    await post("/auth/forgot-password", { email });
    const reset = (await outbox(email)).find((m) => m.kind === "reset");
    expect(reset?.body).toContain(WALLET_NOT_RESTORED);
    expect(reset?.body).toMatch(/recovery phrase/);
  });

  it("a reset sets the new password, ends every session and works once", async () => {
    const { email, cookies } = await signUp();
    await post("/auth/forgot-password", { email });
    const token = linkIn((await outbox(email)).find((m) => m.kind === "reset")?.body ?? "");
    const weak = await post("/auth/reset-password", { token, password: "short" });
    expect(weak.statusCode).toBe(422);
    const res = await post("/auth/reset-password", { token, password: "a brand new passphrase!" });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/me", cookies })).statusCode).toBe(401);
    expect((await post("/auth/login", { email, password: PASSWORD })).statusCode).toBe(401);
    expect(
      (await post("/auth/login", { email, password: "a brand new passphrase!" })).statusCode,
    ).toBe(200);
    expect(
      (await post("/auth/reset-password", { token, password: "yet another passphrase" }))
        .statusCode,
    ).toBe(400);
  });

  it("a reset never restores or reveals wallet access: the account has no wallet either way", async () => {
    const { email, cookies } = await signUp();
    await post("/auth/forgot-password", { email });
    const token = linkIn((await outbox(email)).find((m) => m.kind === "reset")?.body ?? "");
    await post("/auth/reset-password", { token, password: "a brand new passphrase!" });
    const login = await post("/auth/login", { email, password: "a brand new passphrase!" });
    const me = await app.inject({ method: "GET", url: "/me", cookies: sessionCookie(login) });
    expect(me.json().user.nearAccountId).toBeNull();
    expect(cookies).toBeDefined();
  });

  it("an expired reset link is refused", async () => {
    const { email } = await signUp();
    await post("/auth/forgot-password", { email });
    const token = linkIn((await outbox(email)).find((m) => m.kind === "reset")?.body ?? "");
    const was = h.clock.now;
    h.clock.now = new Date(was.getTime() + 61 * 60_000);
    expect(
      (await post("/auth/reset-password", { token, password: "a brand new passphrase!" }))
        .statusCode,
    ).toBe(400);
    h.clock.now = was;
  });

  it("changing the password needs the current one and signs out other sessions", async () => {
    const { email, cookies } = await signUp();
    const other = sessionCookie(await post("/auth/login", { email, password: PASSWORD }));
    const wrong = await post(
      "/auth/change-password",
      { currentPassword: "nope nope nope", newPassword: "another good passphrase" },
      cookies,
    );
    expect(wrong.statusCode).toBe(401);
    const ok = await post(
      "/auth/change-password",
      { currentPassword: PASSWORD, newPassword: "another good passphrase" },
      cookies,
    );
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/me", cookies: other })).statusCode).toBe(401);
  });
});

describe("link a wallet to an email account", () => {
  async function linkChallenge(cookies: Record<string, string>, wallet: Wallet) {
    const res = await post("/auth/wallet-link/challenge", { accountId: wallet.accountId }, cookies);
    return res.json() as { message: string; nonce: string; recipient: string };
  }
  const link = (
    cookies: Record<string, string>,
    wallet: Wallet,
    c: { message: string; nonce: string },
  ) =>
    post(
      "/auth/wallet-link",
      {
        accountId: wallet.accountId,
        publicKey: wallet.publicKey,
        signature: wallet.sign(c.message, c.nonce, RECIPIENT),
        nonce: c.nonce,
      },
      cookies,
    );

  it("a signature from the wallet links it, and then the organisation can be created", async () => {
    const { cookies } = await signUp();
    const wallet = new Wallet();
    const c = await linkChallenge(cookies!, wallet);
    expect(c.message.split("\n")[0]).toBe("Link this wallet to Veylo");
    expect((await link(cookies!, wallet, c)).statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/me", cookies });
    expect(me.json().user.nearAccountId).toBe(wallet.accountId);
    const org = await createOrg(app, cookies!);
    expect(org.treasuryAccountId).toBe(wallet.accountId);
  });

  it("refuses a bad signature, a replay and another person's challenge", async () => {
    const a = await signUp();
    const b = await signUp();
    const wallet = new Wallet();
    const c = await linkChallenge(a.cookies!, wallet);
    const forged = await post(
      "/auth/wallet-link",
      {
        accountId: wallet.accountId,
        publicKey: wallet.publicKey,
        signature: new Wallet().sign(c.message, c.nonce, RECIPIENT),
        nonce: c.nonce,
      },
      a.cookies,
    );
    expect(forged.statusCode).toBe(401);
    expect((await link(b.cookies!, wallet, c)).statusCode).toBe(401);
    expect((await link(a.cookies!, wallet, c)).statusCode).toBe(200);
    expect((await link(a.cookies!, wallet, c)).statusCode).toBe(401);
  });

  it("refuses a wallet that already belongs to another account", async () => {
    const wallet = new Wallet();
    await signIn(app, wallet);
    const { cookies } = await signUp();
    const c = await linkChallenge(cookies!, wallet);
    const res = await link(cookies!, wallet, c);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("WALLET_TAKEN");
  });

  it("a sign-in challenge cannot be used to link", async () => {
    const { cookies } = await signUp();
    const wallet = new Wallet();
    const c = (await post("/auth/challenge", { accountId: wallet.accountId })).json() as {
      message: string;
      nonce: string;
    };
    expect((await link(cookies!, wallet, c)).statusCode).toBe(401);
  });

  it("linking needs a signed-in account", async () => {
    const wallet = new Wallet();
    expect(
      (await post("/auth/wallet-link/challenge", { accountId: wallet.accountId })).statusCode,
    ).toBe(401);
  });
});
