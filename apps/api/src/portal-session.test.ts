// A contractor's own private balance (slice W6, follow-up 2): the session that reads it is opened by
// their wallet signing an EMPTY intent, and only for the account they signed in with. It reads; it
// moves nothing. Tokens are encrypted at rest, a refreshed token is used silently, and a balance is
// shown only when 1Click answered.
import { randomBytes } from "node:crypto";
import { schema } from "@veylo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  createHarness,
  createOrg,
  sessionCookie,
  signIn,
  Wallet,
  type App,
} from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
const START = new Date("2026-11-06T10:00:00.000Z");
beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

type Cookies = Record<string, string>;
const call = (method: "GET" | "POST", url: string, cookies: Cookies, payload?: object) =>
  app.inject({ method, url, cookies, payload });

async function joined() {
  h.clock.now = START;
  h.one.balancesStatus = 200;
  const owner = await signIn(app);
  const org = await createOrg(app, owner.cookies);
  const made = await call("POST", `/orgs/${org.id}/contractors`, owner.cookies, {
    name: "Ada Lovelace",
    terms: { kind: "fixed", rate: "5000000", schedule: "monthly" },
  });
  const contractorId = (made.json() as { id: string }).id;
  const invite = (
    await call("POST", `/orgs/${org.id}/contractors/${contractorId}/invites`, owner.cookies)
  ).json() as { token: string };
  const contractor = await signIn(app);
  await call("POST", "/portal/invites/accept", contractor.cookies, { token: invite.token });
  const base = `/portal/contractors/${contractorId}`;
  return { owner, org, contractorId, contractor, base };
}

type World = Awaited<ReturnType<typeof joined>>;

const requestSession = async (w: World) =>
  (await call("POST", `${w.base}/session-request`, w.contractor.cookies)).json();

const complete = (
  w: World,
  req: { requestId: string; payload: { message: string; nonce: string; recipient: string } },
  signer: Wallet,
  cookies: Cookies = w.contractor.cookies,
) =>
  call("POST", `${w.base}/session-request/${req.requestId}/complete`, cookies, {
    accountId: signer.accountId,
    publicKey: signer.publicKey,
    signature: signer.sign(req.payload.message, req.payload.nonce, req.payload.recipient),
  });

async function openSession(w: World, signer: Wallet = w.contractor.wallet) {
  const req = await requestSession(w);
  return { req, done: await complete(w, req, signer) };
}

describe("the contractor's private balance", () => {
  it("needs a session before anything is read", async () => {
    const w = await joined();
    const r = (await call("GET", `${w.base}/balance`, w.contractor.cookies)).json();
    expect(r).toMatchObject({ available: false, unavailable: "needs_session" });
  });

  it("asks for an empty intent for the account they signed in with, then reads the balance", async () => {
    const w = await joined();
    const req = await requestSession(w);
    expect(JSON.parse(req.payload.message)).toMatchObject({
      intents: [],
      signer_id: w.contractor.wallet.accountId,
    });
    expect(req.payload.recipient).toBe("intents.near");
    expect(req.summary).toMatch(/moves no funds/);

    const done = await complete(w, req, w.contractor.wallet);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ status: "active" });

    const bal = (await call("GET", `${w.base}/balance`, w.contractor.cookies)).json();
    expect(bal).toMatchObject({ available: true, amount: "500000" });
    expect(bal.source).toBe("1Click: /v0/account/balances");
    expect(h.one.lastBearer).toBe(ACCESS_TOKEN);
  });

  it("keeps 1Click's tokens encrypted and out of every response and audit row", async () => {
    const w = await joined();
    await openSession(w);
    const rows = await h.db.select().from(schema.sessions1ClickContractor);
    expect(rows.filter((r) => r.contractorId === w.contractorId)).toHaveLength(1);
    const dump = JSON.stringify(rows) + JSON.stringify(await h.db.select().from(schema.auditLog));
    expect(dump).not.toContain(ACCESS_TOKEN);
    expect(dump).not.toContain(REFRESH_TOKEN);
    const res = await call("GET", `${w.base}/balance`, w.contractor.cookies);
    expect(res.body).not.toContain(ACCESS_TOKEN);
  });

  it("refuses a signature from any wallet but the one they signed in with", async () => {
    const w = await joined();
    const { done } = await openSession(w, new Wallet());
    expect(done.statusCode).toBe(403);
    expect(done.json().error.code).toBe("WALLET_REJECTED");
    const bal = (await call("GET", `${w.base}/balance`, w.contractor.cookies)).json();
    expect(bal.available).toBe(false);
  });

  it("refuses a signature over other bytes, and one from a key that isn't the account's", async () => {
    const w = await joined();
    const req = await requestSession(w);
    const wallet = w.contractor.wallet;
    const other = JSON.stringify({
      deadline: "2099-01-01T00:00:00.000Z",
      intents: [],
      signer_id: wallet.accountId,
    });
    const wrongBytes = await call(
      "POST",
      `${w.base}/session-request/${req.requestId}/complete`,
      w.contractor.cookies,
      {
        accountId: wallet.accountId,
        publicKey: wallet.publicKey,
        signature: wallet.sign(other, req.payload.nonce, req.payload.recipient),
      },
    );
    expect(wrongBytes.statusCode).toBe(403);

    const impostor = new Wallet();
    const wrongKey = await call(
      "POST",
      `${w.base}/session-request/${req.requestId}/complete`,
      w.contractor.cookies,
      {
        accountId: wallet.accountId,
        publicKey: impostor.publicKey,
        signature: impostor.sign(req.payload.message, req.payload.nonce, req.payload.recipient),
      },
    );
    expect(wrongKey.statusCode).toBe(403);
  });

  it("makes each request single-use and short-lived", async () => {
    const w = await joined();
    const { req, done } = await openSession(w);
    expect(done.statusCode).toBe(200);
    expect((await complete(w, req, w.contractor.wallet)).statusCode).toBe(409);

    const fresh = await requestSession(w);
    h.clock.now = new Date(START.getTime() + 6 * 60_000);
    expect((await complete(w, fresh, w.contractor.wallet)).statusCode).toBe(409);
  });

  it("refreshes an expired access token on the server, and asks to sign again when 1Click refuses", async () => {
    const w = await joined();
    await openSession(w);
    h.clock.now = new Date(START.getTime() + 1000 * 1000); // past the 900-second access token
    const refreshed = (await call("GET", `${w.base}/balance`, w.contractor.cookies)).json();
    expect(refreshed.available).toBe(true);
    expect(h.one.lastBearer).toBe("access-refreshed-sentinel");

    h.one.balancesStatus = 401;
    const refused = (await call("GET", `${w.base}/balance`, w.contractor.cookies)).json();
    expect(refused).toMatchObject({ available: false, unavailable: "needs_session" });
    h.one.balancesStatus = 200;
    const still = (await call("GET", `${w.base}/balance`, w.contractor.cookies)).json();
    expect(still).toMatchObject({ available: false, unavailable: "needs_session" });
  });

  it("says why when 1Click is down, never a guessed number", async () => {
    const w = await joined();
    await openSession(w);
    h.one.balancesStatus = 500;
    const r = (await call("GET", `${w.base}/balance`, w.contractor.cookies)).json();
    expect(r).toMatchObject({ available: false, unavailable: "oneclick_error" });
    expect(r).not.toHaveProperty("amount");
  });

  it("is theirs alone: another user, the owner and a signed-out visitor are refused", async () => {
    const w = await joined();
    const stranger = await signIn(app);
    const req = await requestSession(w);
    for (const cookies of [stranger.cookies, w.owner.cookies]) {
      expect((await call("POST", `${w.base}/session-request`, cookies)).statusCode).toBe(404);
      expect((await complete(w, req, stranger.wallet, cookies)).statusCode).toBe(404);
    }
    expect((await call("POST", `${w.base}/session-request`, {})).statusCode).toBe(401);
  });

  it("needs a linked wallet: an email-only account is told so", async () => {
    const w = await joined();
    const email = `grace-${randomBytes(4).toString("hex")}@example.com`;
    const signUp = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password: "correct horse battery staple 42" },
    });
    expect(signUp.statusCode).toBe(201);
    const cookies = sessionCookie(signUp);
    const made = await call("POST", `/orgs/${w.org.id}/contractors`, w.owner.cookies, {
      name: "Grace",
      terms: { kind: "fixed", rate: "5000000", schedule: "monthly" },
    });
    const gid = (made.json() as { id: string }).id;
    const invite = (
      await call("POST", `/orgs/${w.org.id}/contractors/${gid}/invites`, w.owner.cookies)
    ).json() as { token: string };
    expect(
      (await call("POST", "/portal/invites/accept", cookies, { token: invite.token })).statusCode,
    ).toBe(200);
    const r = await call("POST", `/portal/contractors/${gid}/session-request`, cookies);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("WALLET_REQUIRED");
  });
});
