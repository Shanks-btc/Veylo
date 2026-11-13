import { PAYOUT_ROUTE_IDS } from "@veylo/core";
import { Writable } from "node:stream";
import { schema } from "@veylo/db";
import { eq } from "drizzle-orm";
import { base64 } from "@scure/base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN,
  addMember,
  createHarness,
  createOrg,
  namedWallet,
  QUOTE_KEY,
  REFRESH_TOKEN,
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
beforeEach(() => {
  h.clock.now = START;
  h.one.reset();
  h.rpcHooks.fail = false;
});

const REFUND = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
type Cookies = Record<string, string>;

async function setup(wallet = new Wallet()) {
  const owner = await signIn(app, wallet);
  const org = await createOrg(app, owner.cookies);
  const url = `/orgs/${org.id}/treasury`;
  return { wallet, cookies: owner.cookies, orgId: org.id, url };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const post = (url: string, cookies: Cookies, payload?: object) =>
  app.inject({ method: "POST", url, cookies, ...(payload ? { payload } : {}) });

const signFor = (
  wallet: Wallet,
  payload: { message: string; nonce: string; recipient: string },
) => ({
  accountId: wallet.accountId,
  publicKey: wallet.publicKey,
  signature: wallet.sign(payload.message, payload.nonce, payload.recipient),
});

async function startSession(s: Setup) {
  const res = await post(`${s.url}/session-request`, s.cookies);
  expect(res.statusCode).toBe(201);
  return res.json() as {
    requestId: string;
    payload: { message: string; nonce: string; recipient: string };
    summary: string;
  };
}
async function makeSession(s: Setup) {
  const r = await startSession(s);
  const res = await post(
    `${s.url}/session-request/${r.requestId}/complete`,
    s.cookies,
    signFor(s.wallet, r.payload),
  );
  expect(res.statusCode).toBe(200);
}
const balances = async (s: Pick<Setup, "url" | "cookies">) =>
  (await app.inject({ method: "GET", url: `${s.url}/balances`, cookies: s.cookies })).json();

const funding = (s: Setup, over: object = {}) =>
  post(`${s.url}/funding-quote`, s.cookies, {
    originRoute: "usdt-bsc",
    amount: "2000000000000000000",
    refundAddress: REFUND,
    ...over,
  });
const shield = (s: Setup, amount = "300000") =>
  post(`${s.url}/shield-request`, s.cookies, { amount });
const auditOf = (orgId: string) =>
  h.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId));

describe("session-request", () => {
  it("returns the empty intent to sign, with a versioned nonce using the runtime salt", async () => {
    const s = await setup();
    const r = await startSession(s);
    expect(r.payload.recipient).toBe("intents.near");
    expect(JSON.parse(r.payload.message)).toEqual({
      deadline: "2026-11-06T10:05:00.000Z",
      intents: [],
      signer_id: s.wallet.accountId,
    });
    const nonce = base64.decode(r.payload.nonce);
    expect(Buffer.from(nonce.slice(0, 4)).toString("hex")).toBe("5628f6c6");
    expect(Buffer.from(nonce.slice(5, 9)).toString("hex")).toBe(h.one.salt);
    expect(r.summary).toContain("moves no funds");
  });

  it("uses a changed salt, proving it isn't hardcoded", async () => {
    const s = await setup();
    h.one.salt = "abcdef01";
    const r = await startSession(s);
    expect(Buffer.from(base64.decode(r.payload.nonce).slice(5, 9)).toString("hex")).toBe(
      "abcdef01",
    );
  });

  it("502 if the salt can't be read", async () => {
    const s = await setup();
    h.rpcHooks.fail = true;
    const res = await post(`${s.url}/session-request`, s.cookies);
    expect(res.statusCode).toBe(502);
  });

  it.each(["viewer", "accountant"] as const)("a %s gets 403", async (role) => {
    const s = await setup();
    const m = await addMember(app, s.cookies, s.orgId, role);
    expect((await post(`${s.url}/session-request`, m.cookies)).statusCode).toBe(403);
  });
});

describe("session complete", () => {
  it("authenticates with the mapped signature, and encrypts the tokens at rest", async () => {
    const s = await setup();
    await makeSession(s);
    const sent = h.one.requests.find((r) => r.path === "/v0/auth/authenticate");
    expect(sent?.body.signedData.signature).toMatch(/^ed25519:/);
    expect(sent?.body.signedData.public_key).toBe(s.wallet.publicKey);
    const [row] = await h.db
      .select()
      .from(schema.sessions1Click)
      .where(eq(schema.sessions1Click.orgId, s.orgId));
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(ACCESS_TOKEN);
    expect(stored).not.toContain(REFRESH_TOKEN);
    expect(row?.encryptedAccessToken).toMatch(/^v1\./);
    expect(row?.status).toBe("active");
  });

  it("tokens are never returned to the client", async () => {
    const s = await setup();
    const r = await startSession(s);
    const res = await post(
      `${s.url}/session-request/${r.requestId}/complete`,
      s.cookies,
      signFor(s.wallet, r.payload),
    );
    expect(res.json()).toEqual({ status: "active" });
    expect(JSON.stringify(await balances(s))).not.toContain(ACCESS_TOKEN);
  });

  async function rejected(s: Setup, payload: object, requestId: string) {
    const res = await post(`${s.url}/session-request/${requestId}/complete`, s.cookies, payload);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TREASURY_SIGNER_REJECTED");
    expect(h.one.requests.filter((x) => x.path === "/v0/auth/authenticate")).toEqual([]);
  }

  it("rejects an owner who isn't the treasury account", async () => {
    const s = await setup();
    const other = await addMember(app, s.cookies, s.orgId, "owner");
    const r = await startSession(s);
    await rejected(s, signFor(other.wallet, r.payload), r.requestId);
  });

  it("rejects a stranger's key claiming to be the treasury", async () => {
    const s = await setup();
    const r = await startSession(s);
    await rejected(
      s,
      { ...signFor(new Wallet(), r.payload), accountId: s.wallet.accountId },
      r.requestId,
    );
  });

  it("rejects a function-call key", async () => {
    const wallet = namedWallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, "FullAccess"]]));
    const s = await setup(wallet);
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, { FunctionCall: {} }]]));
    const r = await startSession(s);
    await rejected(s, signFor(wallet, r.payload), r.requestId);
  });

  it("rejects a signature over a changed payload, before calling 1Click", async () => {
    const s = await setup();
    const r = await startSession(s);
    await rejected(
      s,
      signFor(s.wallet, { ...r.payload, message: `${r.payload.message} ` }),
      r.requestId,
    );
  });

  it("can't be replayed, and expires", async () => {
    const s = await setup();
    const r = await startSession(s);
    const url = `${s.url}/session-request/${r.requestId}/complete`;
    await post(url, s.cookies, signFor(s.wallet, r.payload));
    expect((await post(url, s.cookies, signFor(s.wallet, r.payload))).json().error.code).toBe(
      "REQUEST_USED",
    );
    const r2 = await startSession(s);
    h.clock.now = new Date(START.getTime() + 300_000);
    const fresh = await signIn(app, s.wallet);
    const res = await post(
      `${s.url}/session-request/${r2.requestId}/complete`,
      fresh.cookies,
      signFor(s.wallet, r2.payload),
    );
    expect(res.json().error.code).toBe("REQUEST_EXPIRED");
  });

  it("a 1Click failure is a 502, storing nothing", async () => {
    const s = await setup();
    const r = await startSession(s);
    h.one.authStatus = 401;
    const res = await post(
      `${s.url}/session-request/${r.requestId}/complete`,
      s.cookies,
      signFor(s.wallet, r.payload),
    );
    expect(res.statusCode).toBe(502);
    const rows = await h.db
      .select()
      .from(schema.sessions1Click)
      .where(eq(schema.sessions1Click.orgId, s.orgId));
    expect(rows).toEqual([]);
  });

  it("signing again replaces the session, keeping one row", async () => {
    const s = await setup();
    await makeSession(s);
    await makeSession(s);
    const rows = await h.db
      .select()
      .from(schema.sessions1Click)
      .where(eq(schema.sessions1Click.orgId, s.orgId));
    expect(rows).toHaveLength(1);
    expect((await balances(s)).confidential.available).toBe(true);
  });
});

describe("encryption is bound to its row", () => {
  it("a ciphertext copied to another org can't be read", async () => {
    const a = await setup();
    const b = await setup();
    await makeSession(a);
    await makeSession(b);
    const [row] = await h.db
      .select()
      .from(schema.sessions1Click)
      .where(eq(schema.sessions1Click.orgId, a.orgId));
    await h.db
      .update(schema.sessions1Click)
      .set({ encryptedAccessToken: row?.encryptedAccessToken as string })
      .where(eq(schema.sessions1Click.orgId, b.orgId));
    const res = await app.inject({ method: "GET", url: `${b.url}/balances`, cookies: b.cookies });
    expect(res.json().confidential).toMatchObject({ available: false });
    expect(JSON.stringify(res.json())).not.toContain(ACCESS_TOKEN);
  });
});

describe("balances", () => {
  it("reports both, each with its source and asOf", async () => {
    const s = await setup();
    await makeSession(s);
    h.one.publicBalance = "987557";
    h.one.privateBalance = "300000";
    const res = await balances(s);
    expect(res.public).toMatchObject({
      available: true,
      amount: "987557",
      source: "NEAR RPC: mt_balance_of on intents.near",
      asOf: START.toISOString(),
    });
    expect(res.confidential).toMatchObject({
      available: true,
      amount: "300000",
      source: "1Click: /v0/account/balances",
      asOf: START.toISOString(),
    });
  });

  it("with no session: unavailable needs_session, and no number at all", async () => {
    const s = await setup();
    const res = await balances(s);
    expect(res.confidential).toMatchObject({ available: false, unavailable: "needs_session" });
    expect(res.confidential.amount).toBeUndefined();
    expect(res.public.available).toBe(true);
  });

  it("a member of any role can read", async () => {
    const s = await setup();
    const m = await addMember(app, s.cookies, s.orgId, "viewer");
    expect((await balances({ url: s.url, cookies: m.cookies })).public.available).toBe(true);
  });

  it("an RPC failure is labelled, never a guess", async () => {
    const s = await setup();
    h.rpcHooks.fail = true;
    const res = await balances(s);
    expect(res.public).toMatchObject({ available: false, unavailable: "rpc_error" });
    expect(res.public.amount).toBeUndefined();
  });

  it("a 1Click outage is labelled, never a guess", async () => {
    const s = await setup();
    await makeSession(s);
    h.one.balancesStatus = 503;
    const res = await balances(s);
    expect(res.confidential).toMatchObject({ available: false, unavailable: "oneclick_error" });
    expect(res.confidential.amount).toBeUndefined();
  });

  it("no USDC entry is a real zero, per the docs", async () => {
    const s = await setup();
    await makeSession(s);
    h.one.privateBalance = null;
    expect((await balances(s)).confidential).toMatchObject({ available: true, amount: "0" });
  });
});

describe("token refresh", () => {
  const AFTER_ACCESS = new Date(START.getTime() + 901_000);
  const AFTER_REFRESH = new Date(START.getTime() + 604_801_000);
  const signedIn = async (s: Setup) => ({ ...s, cookies: (await signIn(app, s.wallet)).cookies });
  const statusOf = async (orgId: string) =>
    (
      await h.db.select().from(schema.sessions1Click).where(eq(schema.sessions1Click.orgId, orgId))
    )[0]?.status;

  it("refreshes server-side when the access token expires, then uses the new one", async () => {
    const s = await setup();
    await makeSession(s);
    h.clock.now = AFTER_ACCESS;
    const res = await balances(await signedIn(s));
    expect(res.confidential.available).toBe(true);
    expect(h.one.requests.some((r) => r.path === "/v0/auth/refresh")).toBe(true);
    expect(h.one.lastBearer).toBe("access-refreshed-sentinel");
    const [row] = await h.db
      .select()
      .from(schema.sessions1Click)
      .where(eq(schema.sessions1Click.orgId, s.orgId));
    expect(JSON.stringify(row)).not.toContain("access-refreshed-sentinel");
  });

  it("doesn't refresh while the access token is valid", async () => {
    const s = await setup();
    await makeSession(s);
    await balances(s);
    expect(h.one.requests.some((r) => r.path === "/v0/auth/refresh")).toBe(false);
    expect(h.one.lastBearer).toBe(ACCESS_TOKEN);
  });

  it("needs_resign when the refresh token has expired, with no call to 1Click", async () => {
    const s = await setup();
    await makeSession(s);
    h.clock.now = AFTER_REFRESH;
    const res = await balances(await signedIn(s));
    expect(res.confidential).toMatchObject({ available: false, unavailable: "needs_session" });
    expect(await statusOf(s.orgId)).toBe("needs_resign");
    expect(h.one.requests.some((r) => r.path === "/v0/auth/refresh")).toBe(false);
  });

  it("needs_resign when 1Click refuses the refresh", async () => {
    const s = await setup();
    await makeSession(s);
    h.one.refreshStatus = 401;
    h.clock.now = AFTER_ACCESS;
    const res = await balances(await signedIn(s));
    expect(res.confidential.unavailable).toBe("needs_session");
    expect(await statusOf(s.orgId)).toBe("needs_resign");
  });

  it("a refresh outage isn't needs_resign", async () => {
    const s = await setup();
    await makeSession(s);
    h.one.refreshStatus = 503;
    h.clock.now = AFTER_ACCESS;
    const res = await balances(await signedIn(s));
    expect(res.confidential.unavailable).toBe("oneclick_error");
    expect(await statusOf(s.orgId)).toBe("active");
  });

  it("a session 1Click stops accepting becomes needs_session", async () => {
    const s = await setup();
    await makeSession(s);
    h.one.balancesStatus = 401;
    expect((await balances(s)).confidential.unavailable).toBe("needs_session");
    expect(await statusOf(s.orgId)).toBe("needs_resign");
  });

  it("signing again recovers", async () => {
    const s = await setup();
    await makeSession(s);
    h.clock.now = AFTER_REFRESH;
    const fresh = await signedIn(s);
    await balances(fresh);
    await makeSession(fresh);
    expect((await balances(fresh)).confidential.available).toBe(true);
  });
});

describe("funding-quote", () => {
  it("quotes dry then live to the org's own treasury, and records the event", async () => {
    const s = await setup();
    const res = await funding(s);
    expect(res.statusCode).toBe(201);
    const quotes = h.one.requests.filter((r) => r.path === "/v0/quote");
    expect(quotes.map((q) => q.body.dry)).toEqual([true, false]);
    expect(quotes[1]?.body).toMatchObject({
      recipient: s.wallet.accountId,
      recipientType: "INTENTS",
      refundTo: REFUND,
      originAsset: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g",
    });
    const j = res.json();
    expect(j).toMatchObject({
      amountToSend: "2000000000000000000",
      asset: "USDT",
      network: "BNB Smart Chain",
    });
    expect(j.summary).toContain(j.depositAddress);
    const [row] = await h.db
      .select()
      .from(schema.treasuryEvents)
      .where(eq(schema.treasuryEvents.id, j.eventId));
    expect(row).toMatchObject({
      type: "fund",
      originAmount: "2000000000000000000",
      status: "PENDING_DEPOSIT",
      mode: "live",
    });
    expect(row?.correlationId).toBeTruthy();
  });

  it("stores an 18-decimal amount over bigint's range exactly", async () => {
    const s = await setup();
    const big = "123456789012345678901234567890";
    const res = await funding(s, { amount: big });
    const [row] = await h.db
      .select()
      .from(schema.treasuryEvents)
      .where(eq(schema.treasuryEvents.id, res.json().eventId));
    expect(row?.originAmount).toBe(big);
  });

  it.each([
    ["usdc-base", REFUND],
    ["usdc-arbitrum", REFUND],
    ["usdc-solana", "3DxAMQpfLiMPN8e91HoJGAFUzEYRSVMd3LR5crAYEraz"],
    ["usdt-bsc", REFUND],
  ])("accepts origin %s", async (originRoute, refundAddress) => {
    const s = await setup();
    expect((await funding(s, { originRoute, refundAddress, amount: "1000" })).statusCode).toBe(201);
  });

  it.each([
    ["usdc-base", "3DxAMQpfLiMPN8e91HoJGAFUzEYRSVMd3LR5crAYEraz"],
    ["usdt-bsc", "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"],
    ["usdc-solana", REFUND],
  ])("%s refuses refund address %s, before any quote", async (originRoute, refundAddress) => {
    const s = await setup();
    const res = await funding(s, { originRoute, refundAddress });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("ADDRESS_INVALID");
    expect(h.one.requests).toEqual([]);
  });

  it.each([
    { originRoute: "usdc-tron" },
    { amount: "0" },
    { amount: "1.5" },
    { amount: 5 },
    { recipient: "attacker.near" },
  ])("rejects %j", async (over) => {
    const s = await setup();
    expect((await funding(s, over)).statusCode).toBe(400);
    expect(h.one.requests).toEqual([]);
  });

  it("a refused dry quote never goes live, and records nothing", async () => {
    const s = await setup();
    h.one.quoteReject = "recipient is not valid";
    const res = await funding(s);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe("recipient is not valid");
    expect(h.one.requests.filter((r) => r.path === "/v0/quote")).toHaveLength(1);
    const rows = await h.db
      .select()
      .from(schema.treasuryEvents)
      .where(eq(schema.treasuryEvents.orgId, s.orgId));
    expect(rows).toEqual([]);
  });

  it("a viewer gets 403", async () => {
    const s = await setup();
    const m = await addMember(app, s.cookies, s.orgId, "viewer");
    const res = await post(`${s.url}/funding-quote`, m.cookies, {
      originRoute: "usdc-base",
      amount: "1",
      refundAddress: REFUND,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("origin verification labels (L32)", () => {
  it.each([
    ["usdt-bsc", REFUND, "live"],
    ["usdc-base", REFUND, "dry_quote_only"],
    ["usdc-arbitrum", REFUND, "dry_quote_only"],
    ["usdc-solana", "3DxAMQpfLiMPN8e91HoJGAFUzEYRSVMd3LR5crAYEraz", "dry_quote_only"],
  ])("%s is returned with its label", async (originRoute, refundAddress, verification) => {
    const s = await setup();
    const res = await funding(s, { originRoute, refundAddress, amount: "1000" });
    expect(res.json().verification).toBe(verification);
  });
});

describe("events refresh", () => {
  it("records each observed status once, and stops at a terminal one", async () => {
    const s = await setup();
    const id = (await funding(s)).json().eventId;
    const refresh = () => post(`${s.url}/events/${id}/refresh`, s.cookies);
    h.one.statuses = ["PENDING_DEPOSIT", "PROCESSING", "PROCESSING", "SUCCESS", "FAILED"];
    await refresh();
    await refresh();
    await refresh();
    const res = await refresh();
    expect(res.json().status).toBe("SUCCESS");
    expect(res.json().statusHistory.map((x: { status: string }) => x.status)).toEqual([
      "PENDING_DEPOSIT",
      "PROCESSING",
      "SUCCESS",
    ]);
    const calls = h.one.requests.filter((r) => r.path.startsWith("/v0/status")).length;
    expect((await refresh()).json().status).toBe("SUCCESS");
    expect(h.one.requests.filter((r) => r.path.startsWith("/v0/status"))).toHaveLength(calls);
  });

  it("502 on a 1Click outage, keeping the last status", async () => {
    const s = await setup();
    const id = (await funding(s)).json().eventId;
    h.one.statusHttp = 503;
    expect((await post(`${s.url}/events/${id}/refresh`, s.cookies)).statusCode).toBe(502);
  });

  it("an unknown event gets 404", async () => {
    const s = await setup();
    const res = await post(
      `${s.url}/events/00000000-0000-4000-8000-000000000000/refresh`,
      s.cookies,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe("shield", () => {
  async function started(s: Setup) {
    const res = await shield(s);
    expect(res.statusCode).toBe(201);
    return res.json() as {
      eventId: string;
      payload: { message: string; nonce: string; recipient: string };
      summary: string;
    };
  }
  const complete = (s: Setup, id: string, payload: object) =>
    post(`${s.url}/shield-request/${id}/complete`, s.cookies, payload);
  const submits = () => h.one.requests.filter((r) => r.path === "/v0/submit-intent");

  it("quotes dry then live, generates the intent as the treasury, and returns it", async () => {
    const s = await setup();
    const r = await started(s);
    const quotes = h.one.requests.filter((x) => x.path === "/v0/quote");
    expect(quotes.map((q) => q.body.dry)).toEqual([true, false]);
    expect(quotes[1]?.body).toMatchObject({
      depositType: "INTENTS",
      recipientType: "CONFIDENTIAL_INTENTS",
      recipient: s.wallet.accountId,
      refundTo: s.wallet.accountId,
    });
    const gen = h.one.requests.find((x) => x.path === "/v0/generate-intent");
    expect(gen?.body).toMatchObject({
      type: "swap_transfer",
      standard: "nep413",
      signerId: s.wallet.accountId,
    });
    expect(r.summary).toContain("0.3 USDC");
    expect(r.payload.recipient).toBe("intents.near");
  });

  it.each([
    ["a transfer to someone else", { receiver: "evil.near" }],
    ["a different amount", { amount: "300001" }],
    ["another signer", { signer: "evil.near" }],
    ["another verifier", { recipient: "intents.far" }],
    ["another salt", { salt: "e110f317" }],
  ])("refuses a generated intent with %s", async (_name, tamper) => {
    const s = await setup();
    h.one.tamperIntent = tamper;
    const res = await shield(s);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("UNEXPECTED_INTENT");
    const rows = await h.db
      .select()
      .from(schema.treasuryEvents)
      .where(eq(schema.treasuryEvents.orgId, s.orgId));
    expect(rows).toEqual([]);
  });

  it("submits the mapped signature and records the intent hash", async () => {
    const s = await setup();
    const r = await started(s);
    const res = await complete(s, r.eventId, signFor(s.wallet, r.payload));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "SUBMITTED", intentHash: "hash-sentinel" });
    expect(submits()[0]?.body).toMatchObject({
      type: "swap_transfer",
      signedData: {
        standard: "nep413",
        payload: r.payload,
        public_key: s.wallet.publicKey,
        signature: expect.stringMatching(/^ed25519:/),
      },
    });
    const [row] = await h.db
      .select()
      .from(schema.treasuryEvents)
      .where(eq(schema.treasuryEvents.id, r.eventId));
    expect(row?.intentHash).toBe("hash-sentinel");
  });

  it("refresh follows it through the same endpoint", async () => {
    const s = await setup();
    const r = await started(s);
    await complete(s, r.eventId, signFor(s.wallet, r.payload));
    h.one.statuses = ["SUCCESS"];
    const res = await post(`${s.url}/events/${r.eventId}/refresh`, s.cookies);
    expect(res.json().status).toBe("SUCCESS");
  });

  async function rejected(s: Setup, id: string, payload: object) {
    const res = await complete(s, id, payload);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("TREASURY_SIGNER_REJECTED");
    expect(submits()).toEqual([]);
  }

  it("rejects an owner who isn't the treasury, submitting nothing", async () => {
    const s = await setup();
    const other = await addMember(app, s.cookies, s.orgId, "owner");
    const r = await started(s);
    await rejected(s, r.eventId, signFor(other.wallet, r.payload));
  });

  it("rejects a bad signature locally, submitting nothing", async () => {
    const s = await setup();
    const r = await started(s);
    await rejected(
      s,
      r.eventId,
      signFor(s.wallet, { ...r.payload, message: `${r.payload.message} ` }),
    );
  });

  it("rejects a function-call key, submitting nothing", async () => {
    const wallet = namedWallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, "FullAccess"]]));
    const s = await setup(wallet);
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, { FunctionCall: {} }]]));
    const r = await started(s);
    await rejected(s, r.eventId, signFor(wallet, r.payload));
  });

  it("a signature can't be submitted twice, even at once", async () => {
    const s = await setup();
    const r = await started(s);
    const sig = signFor(s.wallet, r.payload);
    // Hold both at the key check, so both have read the event as awaiting a signature.
    let arrived = 0;
    let release: () => void = () => {};
    const both = new Promise<void>((resolve) => (release = resolve));
    h.rpcHooks.before = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await both;
    };
    const results = await Promise.all([complete(s, r.eventId, sig), complete(s, r.eventId, sig)]);
    h.rpcHooks.before = undefined;
    expect(results.map((x) => x.statusCode).sort()).toEqual([200, 409]);
    expect(submits()).toHaveLength(1);
    expect((await complete(s, r.eventId, sig)).json().error.code).toBe("REQUEST_USED");
  });

  it("expires", async () => {
    const s = await setup();
    const r = await started(s);
    h.clock.now = new Date(START.getTime() + 30 * 60_000);
    const fresh = await signIn(app, s.wallet);
    const res = await complete(
      { ...s, cookies: fresh.cookies },
      r.eventId,
      signFor(s.wallet, r.payload),
    );
    expect(res.json().error.code).toBe("REQUEST_EXPIRED");
    expect(submits()).toEqual([]);
  });

  it("an uncertain submit is never retried", async () => {
    const s = await setup();
    const r = await started(s);
    h.one.submitStatus = 503;
    const sig = signFor(s.wallet, r.payload);
    expect((await complete(s, r.eventId, sig)).statusCode).toBe(502);
    h.one.submitStatus = 201;
    expect((await complete(s, r.eventId, sig)).statusCode).toBe(409);
    expect(submits()).toHaveLength(1);
    const [row] = await h.db
      .select()
      .from(schema.treasuryEvents)
      .where(eq(schema.treasuryEvents.id, r.eventId));
    expect(row?.status).toBe("SUBMIT_UNCERTAIN");
  });

  it("a funding event can't be completed as a shield", async () => {
    const s = await setup();
    const id = (await funding(s)).json().eventId;
    expect(
      (
        await complete(
          s,
          id,
          signFor(s.wallet, {
            message: "m",
            nonce: Buffer.alloc(32).toString("base64"),
            recipient: "r",
          }),
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe("audit", () => {
  it("records session, funding and shield, with no token or signature", async () => {
    const s = await setup();
    await makeSession(s);
    await funding(s);
    const r = (await shield(s)).json();
    const sig = signFor(s.wallet, r.payload);
    await post(`${s.url}/shield-request/${r.eventId}/complete`, s.cookies, sig);
    const rows = await auditOf(s.orgId);
    expect(
      rows
        .map((x) => x.action)
        .filter((a) => a.startsWith("treasury."))
        .sort(),
    ).toEqual([
      "treasury.funding_quote",
      "treasury.session_create",
      "treasury.shield_request",
      "treasury.shield_submit",
    ]);
    const text = JSON.stringify(rows);
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, sig.signature]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("no secrets in logs", () => {
  it("a whole session, refresh, funding and shield flow at trace level", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _e, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logged = await h.build({
      logStream: stream,
      config: {
        // Tests keep every payout route covered (L46).
        enabledPayoutRoutes: PAYOUT_ROUTE_IDS,
        authRecipient: "veylo.test",
        webOrigin: "https://app.veylo.test",
        sessionTtlHours: 24 * 30,
        logLevel: "trace",
      },
    });
    const owner = await signIn(logged);
    const org = await createOrg(logged, owner.cookies);
    const url = `/orgs/${org.id}/treasury`;
    const go = (path: string, payload?: object) =>
      logged.inject({
        method: "POST",
        url: `${url}${path}`,
        cookies: owner.cookies,
        ...(payload ? { payload } : {}),
      });
    const r = (await go("/session-request")).json();
    const sig = signFor(owner.wallet, r.payload);
    await go(`/session-request/${r.requestId}/complete`, sig);
    h.clock.now = new Date(START.getTime() + 901_000);
    await logged.inject({ method: "GET", url: `${url}/balances`, cookies: owner.cookies });
    h.one.balancesStatus = 503;
    await logged.inject({ method: "GET", url: `${url}/balances`, cookies: owner.cookies });
    await go("/funding-quote", { originRoute: "usdc-base", amount: "1000", refundAddress: REFUND });
    const sh = (await go("/shield-request", { amount: "1000" })).json();
    const sig2 = signFor(owner.wallet, sh.payload);
    await go(`/shield-request/${sh.eventId}/complete`, sig2);
    const log = lines.join("");
    expect(lines.length).toBeGreaterThan(10);
    for (const secret of [
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      "access-refreshed-sentinel",
      QUOTE_KEY,
      sig.signature,
      sig2.signature,
    ]) {
      expect(log).not.toContain(secret);
    }
    await logged.close();
  });
});

describe("funding options (W6)", () => {
  const NEAR_REFUND = "northwind-refunds.near";

  it("USDC on NEAR is accepted, goes to the treasury's own Intents balance, and says it is unproven", async () => {
    const s = await setup();
    const res = await funding(s, {
      originRoute: "usdc-near",
      amount: "1000000",
      refundAddress: NEAR_REFUND,
    });
    expect(res.statusCode).toBe(201);
    const j = res.json();
    expect(j).toMatchObject({
      originId: "usdc-near",
      asset: "USDC",
      network: "NEAR",
      verification: "unproven",
      convertsToUsdc: false,
      treasuryAccountId: s.wallet.accountId,
      refundAddress: NEAR_REFUND,
    });
    const live = h.one.requests.filter((r) => r.path === "/v0/quote").at(-1)?.body;
    expect(live).toMatchObject({
      swapType: "EXACT_INPUT",
      originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      depositType: "ORIGIN_CHAIN",
      recipient: s.wallet.accountId,
      recipientType: "INTENTS",
    });
  });

  it("returns the signed quote and the amounts the browser shows before it shows the address", async () => {
    const s = await setup();
    const j = (await funding(s)).json();
    expect(j.signedQuote.signature).toBeTruthy();
    expect(j.signedQuote.quote.depositAddress).toBe(j.depositAddress);
    expect(j.amountOut).toMatch(/^\d+$/);
    expect(j.amountOutFormatted.length).toBeGreaterThan(0);
    expect(j.convertsToUsdc).toBe(true);
  });

  it.each([["near"], ["usdt-near"]])(
    "%s shows coming soon: the API refuses it until its spike passes",
    async (originRoute) => {
      const s = await setup();
      const res = await funding(s, { originRoute, amount: "1000000", refundAddress: NEAR_REFUND });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("FUNDING_NOT_ENABLED");
      expect(h.one.requests.filter((r) => r.path === "/v0/quote")).toHaveLength(0);
    },
  );

  it("NEAR and USDT on NEAR work once enabled, converting into USDC with EXACT_INPUT", async () => {
    const { FUNDING_ORIGIN_IDS } = await import("@veylo/core");
    const enabled = await h.build({
      config: {
        authRecipient: "veylo.test",
        webOrigin: "https://app.veylo.test",
        sessionTtlHours: 24,
        logLevel: "silent",
        enabledPayoutRoutes: PAYOUT_ROUTE_IDS,
        enabledFundingOrigins: FUNDING_ORIGIN_IDS,
      },
    });
    const owner = await signIn(enabled, new Wallet());
    const org = await createOrg(enabled, owner.cookies);
    for (const [originRoute, assetId] of [
      ["near", "nep141:wrap.near"],
      ["usdt-near", "nep141:usdt.tether-token.near"],
    ] as const) {
      h.one.reset();
      const res = await enabled.inject({
        method: "POST",
        url: `/orgs/${org.id}/treasury/funding-quote`,
        cookies: owner.cookies,
        payload: { originRoute, amount: "1000000", refundAddress: NEAR_REFUND },
      });
      expect(res.statusCode, originRoute).toBe(201);
      expect(res.json().convertsToUsdc).toBe(true);
      const live = h.one.requests.filter((r) => r.path === "/v0/quote").at(-1)?.body;
      expect(live).toMatchObject({
        swapType: "EXACT_INPUT",
        originAsset: assetId,
        destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        recipientType: "INTENTS",
      });
    }
    await enabled.close();
  });

  it("a NEAR refund address must be a valid NEAR account", async () => {
    const s = await setup();
    const res = await funding(s, {
      originRoute: "usdc-near",
      amount: "1000000",
      refundAddress: "NOT A NEAR ACCOUNT",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("ADDRESS_INVALID");
  });
});
