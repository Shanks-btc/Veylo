import { Writable } from "node:stream";
import { schema } from "@veylo/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIDENTIAL_TOKEN_PREFIX } from "./payout-routes.js";
import { createSettlement, RECONCILE_DELAY_MS } from "./settlement.js";
import {
  addMember,
  createHarness,
  createOrg,
  namedWallet,
  RECIPIENT,
  signIn,
  Wallet,
  type App,
} from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
let jobs: ReturnType<typeof createSettlement>;
const START = new Date("2026-11-07T10:00:00.000Z");
const quiet = { info() {}, warn() {}, error() {} };
const at = (ms: number) => new Date(START.getTime() + ms);
beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
  jobs = createSettlement({
    db: h.db,
    clock: () => h.clock.now,
    oneclickTreasury: h.treasuryClient,
    secrets: h.secrets,
    intents: h.intentsReader,
    rpc: h.rpc,
    config: {} as never,
  } as never);
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});
beforeEach(() => {
  h.clock.now = START;
  h.one.reset();
  h.rpcHooks.before = undefined;
  h.rpcHooks.fail = false;
});

type Cookies = Record<string, string>;
const EVM = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
const TERMS = { kind: "fixed", rate: "1", schedule: "monthly" };
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const post = (url: string, cookies: Cookies, payload?: object) =>
  app.inject({ method: "POST", url, cookies, ...(payload ? { payload } : {}) });
const get = (url: string, cookies: Cookies) => app.inject({ method: "GET", url, cookies });

async function approveDestination(o: Org, base: string, destinationId: string) {
  const r = (
    await post(`${base}/destinations/${destinationId}/approval-request`, o.cookies)
  ).json();
  const res = await post(
    `${base}/destinations/${destinationId}/approval-request/${r.requestId}/complete`,
    o.cookies,
    {
      accountId: o.wallet.accountId,
      publicKey: o.wallet.publicKey,
      approvalSignature: o.wallet.sign(r.approvalMessage, r.approvalNonce, RECIPIENT),
      headSignature: o.wallet.sign(r.headMessage, r.headNonce, RECIPIENT),
    },
  );
  return res.json().approvalId as string;
}
type Org = { wallet: Wallet; cookies: Cookies; orgId: string };

/** A live run with one approved Direct payee, quoted and in Signing. */
async function signing(opts: { wallet?: Wallet; route?: string; address?: string } = {}) {
  const wallet = opts.wallet ?? new Wallet();
  const owner = await signIn(app, wallet);
  const org = await createOrg(app, owner.cookies);
  const o: Org = { wallet, cookies: owner.cookies, orgId: org.id };
  const c = (
    await post(`/orgs/${o.orgId}/contractors`, o.cookies, { name: "Ada", terms: TERMS })
  ).json();
  const base = `/orgs/${o.orgId}/contractors/${c.id}`;
  const d = (
    await post(`${base}/destinations`, o.cookies, {
      route: opts.route ?? "usdc-base",
      address: opts.address ?? EVM,
    })
  ).json();
  const approvalId = await approveDestination(o, base, d.id);
  const s = (await post(`/orgs/${o.orgId}/treasury/session-request`, o.cookies)).json();
  await post(`/orgs/${o.orgId}/treasury/session-request/${s.requestId}/complete`, o.cookies, {
    accountId: wallet.accountId,
    publicKey: wallet.publicKey,
    signature: wallet.sign(s.payload.message, s.payload.nonce, s.payload.recipient),
  });
  const run = (
    await post(`/orgs/${o.orgId}/pay-runs`, o.cookies, { period: "2026-11", mode: "live" })
  ).json();
  const url = `/orgs/${o.orgId}/pay-runs/${run.id}`;
  const itemId = (
    await post(`${url}/items`, o.cookies, { contractorId: c.id, amount: "50000" })
  ).json().id;
  await post(`${url}/prepare`, o.cookies);
  expect((await post(`${url}/approve`, o.cookies)).statusCode).toBe(200);
  expect((await post(`${url}/quote`, o.cookies)).json().status).toBe("Signing");
  const itemUrl = `${url}/items/${itemId}`;
  return { o, url, itemUrl, itemId, approvalId, destinationId: d.id as string, base };
}
type S = Awaited<ReturnType<typeof signing>>;

const signRequest = async (s: S) => post(`${s.itemUrl}/sign-request`, s.o.cookies);
async function signAndSubmit(s: S, wallet = s.o.wallet) {
  const r = (await signRequest(s)).json();
  return post(`${s.itemUrl}/sign-request/${r.requestId}/complete`, s.o.cookies, {
    accountId: wallet.accountId,
    publicKey: wallet.publicKey,
    signature: wallet.sign(r.payload.message, r.payload.nonce, r.payload.recipient),
  });
}
const attempt = async (s: S) =>
  (
    await h.db
      .select()
      .from(schema.payoutAttempts)
      .where(eq(schema.payoutAttempts.lineItemId, s.itemId))
  ).sort((a, b) => b.attemptNo - a.attemptNo)[0];
const runStatus = async (s: S) => (await get(s.url, s.o.cookies)).json().status as string;
const encumbrances = (orgId: string) =>
  h.db.select().from(schema.encumbrances).where(eq(schema.encumbrances.orgId, orgId));
const submits = () => h.one.requests.filter((r) => r.path === "/v0/submit-intent");

/** Every job, as the worker runs them. */
async function tick() {
  await jobs.resolveUncertainSubmits(quiet);
  await jobs.pollPayoutStatus(quiet);
  await jobs.expireQuotes(quiet);
  await jobs.reconcilePayouts(quiet);
  await jobs.releaseEncumbrances(quiet);
}
const snapshot = async (orgId: string) =>
  JSON.stringify(
    [
      await h.db.select().from(schema.payoutAttempts).where(eq(schema.payoutAttempts.orgId, orgId)),
      await encumbrances(orgId),
      await h.db.select().from(schema.payRuns).where(eq(schema.payRuns.orgId, orgId)),
      await h.db
        .select()
        .from(schema.payoutDestinations)
        .where(eq(schema.payoutDestinations.orgId, orgId)),
    ],
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  );

describe("sign request", () => {
  it("returns the checked payload, a summary, and the browser-gate bundle", async () => {
    const s = await signing();
    const res = await signRequest(s);
    expect(res.statusCode).toBe(201);
    const j = res.json();
    expect(j.payload.recipient).toBe("intents.far");
    const message = JSON.parse(j.payload.message);
    const a = await attempt(s);
    expect(message.intents).toEqual([
      {
        intent: "transfer",
        receiver_id: a?.depositAddress,
        tokens: { [`${CONFIDENTIAL_TOKEN_PREFIX}${USDC}`]: "52900" },
      },
    ]);
    expect(j.summary).toContain("0.05 USDC");
    expect(j.gate).toMatchObject({
      treasuryAccountId: s.o.wallet.accountId,
      quote: { signature: expect.stringMatching(/^ed25519:/) },
      payeeApproval: {
        signature: expect.any(String),
        canonicalRecord: expect.any(String),
        message: expect.any(String),
      },
      registryHead: { signature: expect.any(String), version: 1 },
    });
    expect(a?.signedMessageDeadline?.toISOString()).toBe(message.deadline);
    expect(h.one.saltReads).toContain("intents.far");
  });

  it.each<[string, Record<string, string>]>([
    ["wrong receiver", { receiver: "evil" }],
    ["wrong amount", { amount: "52901" }],
    ["wrong token (the public form)", { token: USDC }],
    ["wrong verifier", { recipient: "intents.near" }],
    ["wrong signer", { signer: "evil.near" }],
    ["wrong salt", { salt: "e110f317" }],
  ])("refuses a generated intent with a %s, storing nothing", async (_n, tamper) => {
    const s = await signing();
    h.one.tamperIntent = tamper;
    const res = await signRequest(s);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("UNEXPECTED_INTENT");
    expect(
      await h.db.select().from(schema.signRequests).where(eq(schema.signRequests.orgId, s.o.orgId)),
    ).toEqual([]);
  });

  it("a payee revoked between quote and sign fails the attempt with gate_blocked", async () => {
    const s = await signing();
    const r = (
      await post(`/orgs/${s.o.orgId}/payees/${s.approvalId}/revoke-request`, s.o.cookies)
    ).json();
    await post(
      `/orgs/${s.o.orgId}/payees/${s.approvalId}/revoke-request/${r.requestId}/complete`,
      s.o.cookies,
      {
        accountId: s.o.wallet.accountId,
        publicKey: s.o.wallet.publicKey,
        headSignature: s.o.wallet.sign(r.headMessage, r.headNonce, RECIPIENT),
      },
    );
    h.one.requests.length = 0;
    const res = await signRequest(s);
    expect(res.json().error.code).toBe("PAYEE_NOT_PAYABLE");
    expect(await attempt(s)).toMatchObject({ status: "FAILED", failureReason: "gate_blocked" });
    expect(h.one.requests.find((x) => x.path === "/v0/generate-intent")).toBeUndefined();
  });

  it("refuses with less than 60 s left", async () => {
    const s = await signing();
    h.clock.now = at(15 * 60_000 - 59_000);
    const fresh = await signIn(app, s.o.wallet);
    const res = await post(`${s.itemUrl}/sign-request`, fresh.cookies);
    expect(res.json().error.code).toBe("QUOTE_TOO_CLOSE_TO_DEADLINE");
  });

  it("a viewer can't sign", async () => {
    const s = await signing();
    const v = await addMember(app, s.o.cookies, s.o.orgId, "viewer");
    expect((await post(`${s.itemUrl}/sign-request`, v.cookies)).statusCode).toBe(403);
  });
});

describe("an unrecognized confidential token (L36)", () => {
  it("blocks signing with unrecognized_confidential_token and an alert", async () => {
    const s = await signing();
    h.one.tamperIntent = { token: `imt:${"0".repeat(64)}:${USDC}` };
    const res = await signRequest(s);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({
      code: "unrecognized_confidential_token",
      message: expect.stringContaining("doesn't recognize"),
    });
    expect(
      await h.db.select().from(schema.signRequests).where(eq(schema.signRequests.orgId, s.o.orgId)),
    ).toEqual([]);
  });
});

describe("complete and submit", () => {
  it("success: SIGNED → SUBMITTED, encumbered, then SUCCESS releases it and settles the run", async () => {
    const s = await signing();
    const res = await signAndSubmit(s);
    expect(res.json()).toMatchObject({
      status: "SUBMITTED",
      intentHash: expect.stringMatching(/^ih-/),
    });
    const sent = submits()[0]?.body.signedData;
    expect(sent.signature).toMatch(/^ed25519:/);
    expect(sent.public_key).toBe(s.o.wallet.publicKey);
    expect(await encumbrances(s.o.orgId)).toMatchObject([{ amount: 52900n, releasedAt: null }]);
    expect(await runStatus(s)).toBe("Settling");

    const a = await attempt(s);
    h.one.statusByDeposit.set(a!.depositAddress!, ["PROCESSING", "SUCCESS"]);
    await jobs.pollPayoutStatus(quiet);
    expect((await attempt(s))?.status).toBe("PROCESSING");
    await jobs.pollPayoutStatus(quiet);
    const done = await attempt(s);
    expect(done).toMatchObject({ status: "SUCCESS", destinationTxHash: "0xdest" });
    expect(done?.nearTxHashes).toEqual(["nt-1"]);
    expect((done?.statusHistory as { status: string }[]).map((x) => x.status)).toEqual([
      "PLANNED",
      "QUOTED",
      "SIGNED",
      "SUBMITTED",
      "PROCESSING",
      "SUCCESS",
    ]);
    const [e] = await encumbrances(s.o.orgId);
    expect(e).toMatchObject({ reason: "success" });
    expect(e?.releasedAt).not.toBeNull();
    expect(await runStatus(s)).toBe("Completed");
  });

  it("records only observed states: SUBMITTED straight to SUCCESS (L18)", async () => {
    const s = await signing();
    await signAndSubmit(s);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["SUCCESS"]);
    await jobs.pollPayoutStatus(quiet);
    const hist = ((await attempt(s))?.statusHistory as { status: string }[]).map((x) => x.status);
    expect(hist.slice(-2)).toEqual(["SUBMITTED", "SUCCESS"]);
  });

  it("success on a Direct route marks the destination publicly paid (rule 8)", async () => {
    const s = await signing();
    await signAndSubmit(s);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["SUCCESS"]);
    await jobs.pollPayoutStatus(quiet);
    const [d] = await h.db
      .select()
      .from(schema.payoutDestinations)
      .where(eq(schema.payoutDestinations.id, s.destinationId));
    expect(d?.receivedPublicPayout).toBe(true);
  });

  it("success on a Private route doesn't", async () => {
    const s = await signing({ route: "usdc-near-confidential", address: "ada.near" });
    await signAndSubmit(s);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["SUCCESS"]);
    await jobs.pollPayoutStatus(quiet);
    const [d] = await h.db
      .select()
      .from(schema.payoutDestinations)
      .where(eq(schema.payoutDestinations.id, s.destinationId));
    expect(d?.receivedPublicPayout).toBe(false);
  });

  it("a refund stays REFUNDED, keeps its encumbrance until reconciled, then reconciles", async () => {
    const s = await signing();
    await signAndSubmit(s);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["REFUNDED"]);
    h.one.refundedAmount = "52900";
    await jobs.pollPayoutStatus(quiet);
    expect((await attempt(s))?.status).toBe("REFUNDED");
    expect((await encumbrances(s.o.orgId))[0]?.releasedAt).toBeNull();
    await jobs.reconcilePayouts(quiet);
    expect((await attempt(s))?.reconciledAt).toBeNull(); // Not yet 30 s.
    h.clock.now = at(RECONCILE_DELAY_MS);
    await jobs.reconcilePayouts(quiet);
    const a = await attempt(s);
    expect(a).toMatchObject({ refundedAmount: 52900n, balanceUnconfirmed: false });
    expect(a?.reconciledAt).not.toBeNull();
    expect((await encumbrances(s.o.orgId))[0]).toMatchObject({ reason: "reconciled" });
    expect(await runStatus(s)).toBe("PartiallyCompleted");
  });

  it("a settlement failure is FAILED settlement_failed, released after reconciliation", async () => {
    const s = await signing();
    await signAndSubmit(s);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["FAILED"]);
    await jobs.pollPayoutStatus(quiet);
    expect(await attempt(s)).toMatchObject({
      status: "FAILED",
      failureReason: "settlement_failed",
    });
    h.clock.now = at(RECONCILE_DELAY_MS);
    await jobs.reconcilePayouts(quiet);
    expect((await encumbrances(s.o.orgId))[0]).toMatchObject({ reason: "reconciled" });
  });

  it("an unexpected 1Click status fails with an alert", async () => {
    const s = await signing();
    await signAndSubmit(s);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["SOMETHING_NEW"]);
    const alerts: string[] = [];
    await jobs.pollPayoutStatus({ ...quiet, error: (_o: object, m: string) => alerts.push(m) });
    expect(await attempt(s)).toMatchObject({
      status: "FAILED",
      failureReason: "settlement_failed",
    });
    expect(alerts[0]).toContain("unexpected 1Click status");
  });

  it("without a session, reconciliation marks the balance unconfirmed", async () => {
    const s = await signing();
    await signAndSubmit(s);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["SUCCESS"]);
    await jobs.pollPayoutStatus(quiet);
    await h.db
      .update(schema.sessions1Click)
      .set({ status: "needs_resign" })
      .where(eq(schema.sessions1Click.orgId, s.o.orgId));
    h.clock.now = at(RECONCILE_DELAY_MS);
    await jobs.reconcilePayouts(quiet);
    expect(await attempt(s)).toMatchObject({ balanceUnconfirmed: true });
  });

  it("'Quote has expired' at submit → EXPIRED, encumbered until the message deadline", async () => {
    const s = await signing();
    h.one.submitQueue = ["expired"];
    expect((await signAndSubmit(s)).json().status).toBe("EXPIRED");
    const a = await attempt(s);
    const [e] = await encumbrances(s.o.orgId);
    expect(e?.until.toISOString()).toBe(a?.signedMessageDeadline?.toISOString());
    await jobs.releaseEncumbrances(quiet);
    expect((await encumbrances(s.o.orgId))[0]?.releasedAt).toBeNull();
    h.clock.now = new Date((a?.signedMessageDeadline as Date).getTime());
    await jobs.releaseEncumbrances(quiet);
    expect((await encumbrances(s.o.orgId))[0]).toMatchObject({ reason: "message_deadline_passed" });
    expect((await attempt(s))?.encryptedSignedPayload).toBeNull();
  });

  it("any other 4xx → FAILED submit_rejected, encumbered until the message deadline", async () => {
    const s = await signing();
    h.one.submitQueue = ["rejected"];
    expect((await signAndSubmit(s)).json().status).toBe("FAILED");
    expect(await attempt(s)).toMatchObject({ failureReason: "submit_rejected" });
    await jobs.releaseEncumbrances(quiet);
    expect((await encumbrances(s.o.orgId))[0]?.releasedAt).toBeNull();
    h.clock.now = new Date(((await attempt(s))?.signedMessageDeadline as Date).getTime());
    await jobs.releaseEncumbrances(quiet);
    expect((await encumbrances(s.o.orgId))[0]).toMatchObject({ reason: "message_deadline_passed" });
  });

  it("a duplicate identical intentHash counts as already submitted", async () => {
    const s = await signing();
    h.one.submitQueue = ["5xx"];
    await signAndSubmit(s);
    const first = await attempt(s);
    expect(first).toMatchObject({ status: "SIGNED", submitOutcome: "uncertain" });
    await jobs.resolveUncertainSubmits(quiet);
    const a = await attempt(s);
    expect(a?.status).toBe("SUBMITTED");
    expect(submits()).toHaveLength(2);
    expect(submits()[0]?.body).toEqual(submits()[1]?.body);
  });

  it("uncertain → resubmit identical → success", async () => {
    const s = await signing();
    h.one.submitQueue = ["network"];
    expect((await signAndSubmit(s)).json()).toMatchObject({
      status: "SIGNED",
      submitOutcome: "uncertain",
    });
    await jobs.resolveUncertainSubmits(quiet);
    expect((await attempt(s))?.status).toBe("SUBMITTED");
    expect(submits().map((x) => JSON.stringify(x.body))).toEqual([
      JSON.stringify(submits()[0]?.body),
      JSON.stringify(submits()[0]?.body),
    ]);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["SUCCESS"]);
    await jobs.pollPayoutStatus(quiet);
    expect((await attempt(s))?.status).toBe("SUCCESS");
  });

  it("uncertain, and 1Click already has it: SUBMITTED with no resubmit", async () => {
    const s = await signing();
    h.one.submitQueue = ["network"];
    await signAndSubmit(s);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["PROCESSING"]);
    await jobs.resolveUncertainSubmits(quiet);
    expect((await attempt(s))?.status).toBe("PROCESSING");
    expect(submits()).toHaveLength(1);
  });

  it("uncertain → past the requested deadline → EXPIRED expired_unsubmitted, encumbrance kept", async () => {
    const s = await signing();
    h.one.submitQueue = ["network"];
    await signAndSubmit(s);
    h.clock.now = new Date(((await attempt(s))?.requestedDeadline as Date).getTime());
    await jobs.resolveUncertainSubmits(quiet);
    expect(await attempt(s)).toMatchObject({ status: "EXPIRED", expiredUnsubmitted: true });
    expect(submits()).toHaveLength(1);
    await jobs.releaseEncumbrances(quiet);
    expect((await encumbrances(s.o.orgId))[0]?.releasedAt).toBeNull();
  });

  it("resubmits are bounded", async () => {
    const s = await signing();
    h.one.submitQueue = ["network", "network", "network", "network", "network"];
    await signAndSubmit(s);
    for (let i = 0; i < 5; i += 1) await jobs.resolveUncertainSubmits(quiet);
    expect(submits()).toHaveLength(3);
    expect((await attempt(s))?.status).toBe("SIGNED");
  });

  it("rejects an owner who isn't the treasury, and a function-call key, submitting nothing", async () => {
    const s = await signing();
    const other = await addMember(app, s.o.cookies, s.o.orgId, "owner");
    const res = await signAndSubmit(s, other.wallet);
    expect(res.json().error.code).toBe("TREASURY_SIGNER_REJECTED");
    const named = namedWallet();
    h.chain.set(named.accountId, new Map([[named.publicKey, "FullAccess"]]));
    const s2 = await signing({ wallet: named });
    h.chain.set(named.accountId, new Map([[named.publicKey, { FunctionCall: {} }]]));
    expect((await signAndSubmit(s2)).json().error.code).toBe("TREASURY_SIGNER_REJECTED");
    expect(submits()).toEqual([]);
    expect(await encumbrances(s.o.orgId)).toEqual([]);
  });

  it("a signature over a changed payload is rejected locally, before submit", async () => {
    const s = await signing();
    const r = (await signRequest(s)).json();
    const res = await post(`${s.itemUrl}/sign-request/${r.requestId}/complete`, s.o.cookies, {
      accountId: s.o.wallet.accountId,
      publicKey: s.o.wallet.publicKey,
      signature: s.o.wallet.sign(`${r.payload.message} `, r.payload.nonce, r.payload.recipient),
    });
    expect(res.json().error.code).toBe("TREASURY_SIGNER_REJECTED");
    expect(submits()).toEqual([]);
  });

  it("a concurrent double-complete submits exactly once", async () => {
    const s = await signing();
    const r = (await signRequest(s)).json();
    const payload = {
      accountId: s.o.wallet.accountId,
      publicKey: s.o.wallet.publicKey,
      signature: s.o.wallet.sign(r.payload.message, r.payload.nonce, r.payload.recipient),
    };
    let arrived = 0;
    let release: () => void = () => {};
    const both = new Promise<void>((resolve) => (release = resolve));
    h.rpcHooks.before = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await both;
    };
    const url = `${s.itemUrl}/sign-request/${r.requestId}/complete`;
    const results = await Promise.all([
      post(url, s.o.cookies, payload),
      post(url, s.o.cookies, payload),
    ]);
    h.rpcHooks.before = undefined;
    expect(results.map((x) => x.statusCode).sort()).toEqual([200, 409]);
    expect(submits()).toHaveLength(1);
    expect(await encumbrances(s.o.orgId)).toHaveLength(1);
  });

  it("a sign request can't be reused", async () => {
    const s = await signing();
    const r = (await signRequest(s)).json();
    const body = {
      accountId: s.o.wallet.accountId,
      publicKey: s.o.wallet.publicKey,
      signature: s.o.wallet.sign(r.payload.message, r.payload.nonce, r.payload.recipient),
    };
    await post(`${s.itemUrl}/sign-request/${r.requestId}/complete`, s.o.cookies, body);
    const again = await post(
      `${s.itemUrl}/sign-request/${r.requestId}/complete`,
      s.o.cookies,
      body,
    );
    expect(again.statusCode).toBe(409);
    expect(submits()).toHaveLength(1);
  });
});

describe("expire-quotes", () => {
  it("QUOTED past the requested deadline → EXPIRED, and the run goes back to Quoting", async () => {
    const s = await signing();
    await jobs.expireQuotes(quiet);
    expect((await attempt(s))?.status).toBe("QUOTED");
    h.clock.now = at(15 * 60_000);
    await jobs.expireQuotes(quiet);
    expect((await attempt(s))?.status).toBe("EXPIRED");
    expect(
      await runStatus({ ...s, o: { ...s.o, cookies: (await signIn(app, s.o.wallet)).cookies } }),
    ).toBe("Quoting");
  });
});

describe("worker idempotency", () => {
  const scenarios: [string, (s: S) => Promise<void>][] = [
    ["submitted", async () => {}],
    [
      "success",
      async (s) => {
        h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["SUCCESS"]);
      },
    ],
    [
      "refunded",
      async (s) => {
        h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["REFUNDED"]);
      },
    ],
  ];
  it.each(scenarios)(
    "%s: running every job twice changes nothing the second time",
    async (_n, setup) => {
      const s = await signing();
      await signAndSubmit(s);
      await setup(s);
      h.clock.now = at(RECONCILE_DELAY_MS);
      await tick();
      await tick();
      const once = await snapshot(s.o.orgId);
      await tick();
      expect(await snapshot(s.o.orgId)).toBe(once);
    },
  );

  it("an uncertain past-deadline attempt expires once", async () => {
    const s = await signing();
    h.one.submitQueue = ["network"];
    await signAndSubmit(s);
    h.clock.now = at(15 * 60_000);
    await tick();
    const once = await snapshot(s.o.orgId);
    await tick();
    expect(await snapshot(s.o.orgId)).toBe(once);
  });
});

describe("retry", () => {
  it("after a refund: a status check, a new attempt, and the run back in Quoting", async () => {
    const s = await signing();
    await signAndSubmit(s);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["REFUNDED"]);
    await jobs.pollPayoutStatus(quiet);
    const early = await post(`${s.itemUrl}/retry`, s.o.cookies);
    expect(early.json().error.code).toBe("NOT_RETRYABLE"); // Not reconciled yet.
    h.clock.now = at(RECONCILE_DELAY_MS);
    await jobs.reconcilePayouts(quiet);
    const fresh = await signIn(app, s.o.wallet);
    const res = await post(`${s.itemUrl}/retry`, fresh.cookies);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ attemptNo: 2, status: "PLANNED" });
    expect((await get(s.url, fresh.cookies)).json().status).toBe("Quoting");
    const view = (await post(`${s.url}/quote`, fresh.cookies)).json();
    expect(view.items[0].attempt).toMatchObject({ attemptNo: 2, status: "QUOTED" });
  });

  it("refused when 1Click shows the payout in progress or paid", async () => {
    const s = await signing();
    h.one.submitQueue = ["expired"];
    await signAndSubmit(s);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["SUCCESS"]);
    const res = await post(`${s.itemUrl}/retry`, s.o.cookies);
    expect(res.json().error.code).toBe("NOT_RETRYABLE");
  });

  it("refused after success", async () => {
    const s = await signing();
    await signAndSubmit(s);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["SUCCESS"]);
    await jobs.pollPayoutStatus(quiet);
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["PENDING_DEPOSIT"]);
    expect((await post(`${s.itemUrl}/retry`, s.o.cookies)).statusCode).toBe(409);
  });
});

describe("encumbrance in the funds check", () => {
  it("available = confidential balance − active encumbrances", async () => {
    const s = await signing();
    await signAndSubmit(s); // Encumbers 52900 of the 500000 balance.
    const c = (
      await post(`/orgs/${s.o.orgId}/contractors`, s.o.cookies, { name: "Bo", terms: TERMS })
    ).json();
    const base = `/orgs/${s.o.orgId}/contractors/${c.id}`;
    const d = (
      await post(`${base}/destinations`, s.o.cookies, { route: "usdc-arbitrum", address: EVM })
    ).json();
    await approveDestination(s.o, base, d.id);
    const run = (
      await post(`/orgs/${s.o.orgId}/pay-runs`, s.o.cookies, { period: "2026-12", mode: "live" })
    ).json();
    const url = `/orgs/${s.o.orgId}/pay-runs/${run.id}`;
    // 447100 + 2900 = 450000 needed; 500000 − 52900 = 447100 available.
    await post(`${url}/items`, s.o.cookies, { contractorId: c.id, amount: "447100" });
    await post(`${url}/prepare`, s.o.cookies);
    const res = await post(`${url}/approve`, s.o.cookies);
    expect(res.json().error).toMatchObject({
      code: "INSUFFICIENT_FUNDS",
      details: { available: "447100", needed: "450000", encumbered: "52900" },
    });
    // Once the first payout succeeds, its encumbrance is released.
    h.one.statusByDeposit.set((await attempt(s))!.depositAddress!, ["SUCCESS"]);
    await jobs.pollPayoutStatus(quiet);
    expect((await post(`${url}/approve`, s.o.cookies)).statusCode).toBe(200);
  });
});

describe("simulated runs never reach signing", () => {
  it("sign-request is refused", async () => {
    const wallet = new Wallet();
    const owner = await signIn(app, wallet);
    const org = await createOrg(app, owner.cookies);
    const o = { wallet, cookies: owner.cookies, orgId: org.id };
    const c = (
      await post(`/orgs/${o.orgId}/contractors`, o.cookies, { name: "Ada", terms: TERMS })
    ).json();
    const base = `/orgs/${o.orgId}/contractors/${c.id}`;
    const d = (
      await post(`${base}/destinations`, o.cookies, { route: "usdc-base", address: EVM })
    ).json();
    await approveDestination(o, base, d.id);
    const run = (
      await post(`/orgs/${o.orgId}/pay-runs`, o.cookies, { period: "2026-11", mode: "simulated" })
    ).json();
    const url = `/orgs/${o.orgId}/pay-runs/${run.id}`;
    const itemId = (
      await post(`${url}/items`, o.cookies, { contractorId: c.id, amount: "1000" })
    ).json().id;
    await post(`${url}/prepare`, o.cookies);
    await post(`${url}/approve`, o.cookies);
    await post(`${url}/quote`, o.cookies);
    const res = await post(`${url}/items/${itemId}/sign-request`, o.cookies);
    expect(res.json().error.code).toBe("SIMULATED");
    expect(h.one.requests.some((x) => x.path === "/v0/generate-intent")).toBe(false);
  });
});

describe("the signed payload is a bearer authorization (L33)", () => {
  it("is encrypted at rest, and never in any log or response", async () => {
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
        authRecipient: RECIPIENT,
        webOrigin: "https://app.veylo.test",
        sessionTtlHours: 24,
        logLevel: "trace",
      },
    });
    const prev = app;
    app = logged;
    const bodies: string[] = [];
    const original = logged.inject.bind(logged);
    (logged as unknown as { inject: unknown }).inject = async (opts: never) => {
      const res = await original(opts);
      bodies.push(res.body);
      return res;
    };
    try {
      const s = await signing();
      h.one.submitQueue = ["network"];
      await signAndSubmit(s);
      await jobs.resolveUncertainSubmits(quiet);
      const sent = submits().at(-1)?.body.signedData.signature as string;
      expect(sent).toMatch(/^ed25519:/);
      const walletSig = lines.length >= 0 ? sent : "";
      for (const url of [
        s.url,
        `/orgs/${s.o.orgId}/pay-runs`,
        `/orgs/${s.o.orgId}/treasury/balances`,
        `/orgs/${s.o.orgId}/payee-registry`,
      ]) {
        await logged.inject({ method: "GET", url, cookies: s.o.cookies });
      }
      const [row] = await h.db
        .select()
        .from(schema.payoutAttempts)
        .where(
          and(
            eq(schema.payoutAttempts.lineItemId, s.itemId),
            isNull(schema.payoutAttempts.payloadDeletedAt),
          ),
        );
      expect(row?.encryptedSignedPayload).toMatch(/^v1\./);
      expect(row?.encryptedSignedPayload).not.toContain(sent.slice(8, 30));
      expect(lines.join("")).not.toContain(walletSig.slice(8));
      for (const b of bodies) expect(b).not.toContain(walletSig.slice(8));
      expect(bodies.length).toBeGreaterThan(10);
    } finally {
      app = prev;
      await logged.close();
    }
  });
});
