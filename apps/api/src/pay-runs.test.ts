import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { schema } from "@veylo/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertApproverIsActiveOwner } from "./pay-run-routes.js";
import {
  addMember,
  createHarness,
  createOrg,
  RECIPIENT,
  signIn,
  signQuote,
  Wallet,
  type App,
} from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
const START = new Date("2026-11-07T10:00:00.000Z");
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
  h.quote.respond = h.quote.accepted;
});

type Cookies = Record<string, string>;
const EVM = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
const EVM_2 = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const TERMS = { kind: "fixed", rate: "1", schedule: "monthly" };

const post = (url: string, cookies: Cookies, payload?: object) =>
  app.inject({ method: "POST", url, cookies, ...(payload ? { payload } : {}) });
const get = (url: string, cookies: Cookies) => app.inject({ method: "GET", url, cookies });

async function newOrg() {
  const wallet = new Wallet();
  const owner = await signIn(app, wallet);
  const org = await createOrg(app, owner.cookies);
  return { wallet, cookies: owner.cookies, orgId: org.id };
}
type Org = Awaited<ReturnType<typeof newOrg>>;

/** A contractor with an accepted destination; approved by the treasury unless told otherwise. */
async function contractor(
  o: Org,
  opts: { approve?: boolean; address?: string; name?: string } = {},
) {
  const c = await post(`/orgs/${o.orgId}/contractors`, o.cookies, {
    name: opts.name ?? "Ada",
    terms: TERMS,
  });
  const contractorId = c.json().id as string;
  const base = `/orgs/${o.orgId}/contractors/${contractorId}`;
  const d = await post(`${base}/destinations`, o.cookies, {
    route: "usdc-base",
    address: opts.address ?? EVM,
  });
  const destinationId = d.json().id as string;
  let approvalId = "";
  if (opts.approve !== false) approvalId = await approveDestination(o, base, destinationId);
  return { contractorId, destinationId, base, approvalId };
}

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
  if (res.statusCode !== 200) throw new Error(res.body);
  return res.json().approvalId as string;
}

async function revoke(o: Org, approvalId: string) {
  const r = (await post(`/orgs/${o.orgId}/payees/${approvalId}/revoke-request`, o.cookies)).json();
  const res = await post(
    `/orgs/${o.orgId}/payees/${approvalId}/revoke-request/${r.requestId}/complete`,
    o.cookies,
    {
      accountId: o.wallet.accountId,
      publicKey: o.wallet.publicKey,
      headSignature: o.wallet.sign(r.headMessage, r.headNonce, RECIPIENT),
    },
  );
  if (res.statusCode !== 200) throw new Error(res.body);
}

async function session(o: Org) {
  const r = (await post(`/orgs/${o.orgId}/treasury/session-request`, o.cookies)).json();
  await post(`/orgs/${o.orgId}/treasury/session-request/${r.requestId}/complete`, o.cookies, {
    accountId: o.wallet.accountId,
    publicKey: o.wallet.publicKey,
    signature: o.wallet.sign(r.payload.message, r.payload.nonce, r.payload.recipient),
  });
}

async function run(o: Org, mode: "live" | "simulated" = "live") {
  const res = await post(`/orgs/${o.orgId}/pay-runs`, o.cookies, { period: "2026-11", mode });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  return { id, url: `/orgs/${o.orgId}/pay-runs/${id}` };
}

async function addItem(o: Org, url: string, contractorId: string, amount = "50000") {
  const res = await post(`${url}/items`, o.cookies, { contractorId, amount });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().id as string;
}

/** A live run with one approved contractor, prepared into review, with a session for funds. */
async function inReview(mode: "live" | "simulated" = "live", amount = "50000") {
  const o = await newOrg();
  const c = await contractor(o);
  if (mode === "live") await session(o);
  const r = await run(o, mode);
  const itemId = await addItem(o, r.url, c.contractorId, amount);
  const prepared = await post(`${r.url}/prepare`, o.cookies);
  expect(prepared.statusCode).toBe(200);
  return { o, c, r, itemId, view: prepared.json() };
}

const quotes = () => h.one.requests.filter((x) => x.path === "/v0/quote");
const audit = async (orgId: string) =>
  (await h.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId))).map(
    (a) => a.action,
  );

describe("runs and items", () => {
  it("an owner creates a Draft run, labelled by mode", async () => {
    const o = await newOrg();
    const live = await post(`/orgs/${o.orgId}/pay-runs`, o.cookies, {
      period: "2026-11",
      mode: "live",
    });
    expect(live.json()).toMatchObject({
      status: "Draft",
      mode: "live",
      simulated: false,
      label: null,
    });
    const sim = await post(`/orgs/${o.orgId}/pay-runs`, o.cookies, {
      period: "2026-11",
      mode: "simulated",
    });
    expect(sim.json()).toMatchObject({
      simulated: true,
      label: expect.stringContaining("SIMULATED"),
    });
    const list = (await get(`/orgs/${o.orgId}/pay-runs`, o.cookies)).json().payRuns;
    expect(list).toHaveLength(2);
  });

  it.each([
    { period: "2026-13", mode: "live" },
    { period: "nov", mode: "live" },
    { period: "2026-11", mode: "fake" },
  ])("rejects %j", async (payload) => {
    const o = await newOrg();
    expect((await post(`/orgs/${o.orgId}/pay-runs`, o.cookies, payload)).statusCode).toBe(400);
  });

  it("a viewer reads but can't create or edit", async () => {
    const o = await newOrg();
    const r = await run(o);
    const v = await addMember(app, o.cookies, o.orgId, "viewer");
    expect((await get(r.url, v.cookies)).statusCode).toBe(200);
    expect(
      (await post(`/orgs/${o.orgId}/pay-runs`, v.cookies, { period: "2026-11", mode: "live" }))
        .statusCode,
    ).toBe(403);
    expect((await post(`${r.url}/prepare`, v.cookies)).statusCode).toBe(403);
  });

  it("adds, edits and deletes items in Draft, keeping the total in step", async () => {
    const o = await newOrg();
    const a = await contractor(o, { approve: false });
    const r = await run(o);
    const itemId = await addItem(o, r.url, a.contractorId, "1000");
    const patch = await app.inject({
      method: "PATCH",
      url: `${r.url}/items/${itemId}`,
      cookies: o.cookies,
      payload: { amount: "2500", memo: "November" },
    });
    expect(patch.statusCode).toBe(200);
    let view = (await get(r.url, o.cookies)).json();
    expect(view.items[0]).toMatchObject({ amount: "2500", memo: "November" });
    expect((await get(`/orgs/${o.orgId}/pay-runs`, o.cookies)).json().payRuns[0].totalAmount).toBe(
      "2500",
    );
    const del = await app.inject({
      method: "DELETE",
      url: `${r.url}/items/${itemId}`,
      cookies: o.cookies,
    });
    expect(del.statusCode).toBe(200);
    view = (await get(r.url, o.cookies)).json();
    expect(view.items).toEqual([]);
  });

  it("one item per contractor per run", async () => {
    const o = await newOrg();
    const a = await contractor(o, { approve: false });
    const r = await run(o);
    await addItem(o, r.url, a.contractorId);
    const again = await post(`${r.url}/items`, o.cookies, {
      contractorId: a.contractorId,
      amount: "1",
    });
    expect(again.json().error.code).toBe("ITEM_EXISTS");
  });

  it.each([1.5, "1.5", "0", "-1", "99999999999999999999", "1e6"])(
    "rejects amount %j",
    async (amount) => {
      const o = await newOrg();
      const a = await contractor(o, { approve: false });
      const r = await run(o);
      const res = await post(`${r.url}/items`, o.cookies, { contractorId: a.contractorId, amount });
      expect(res.statusCode).toBe(400);
    },
  );

  it("an empty run can't be prepared", async () => {
    const o = await newOrg();
    const r = await run(o);
    expect((await post(`${r.url}/prepare`, o.cookies)).json().error.code).toBe("RUN_EMPTY");
  });

  it("items can't change once prepared", async () => {
    const { o, r, itemId, c } = await inReview();
    const patch = await app.inject({
      method: "PATCH",
      url: `${r.url}/items/${itemId}`,
      cookies: o.cookies,
      payload: { amount: "1" },
    });
    expect(patch.json().error.code).toBe("RUN_WRONG_STATUS");
    const del = await app.inject({
      method: "DELETE",
      url: `${r.url}/items/${itemId}`,
      cookies: o.cookies,
    });
    expect(del.statusCode).toBe(409);
    expect(
      (await post(`${r.url}/items`, o.cookies, { contractorId: c.contractorId, amount: "1" }))
        .statusCode,
    ).toBe(409);
  });
});

describe("prepare and review", () => {
  it("moves Draft → Prepared → InReview, with a fresh fee preview and totals", async () => {
    const { view } = await inReview();
    expect(view.status).toBe("InReview");
    const item = view.items[0];
    expect(item.feePreview).toEqual({
      amountIn: "52900",
      minAmountIn: "52400",
      amountOut: "50000",
      deliveryFee: "2400",
      fee: "2400",
      asOf: START.toISOString(),
    });
    expect(view.totals).toEqual({ payoutSum: "50000", feeSum: "2400", grandTotal: "52900" });
    const dry = quotes().filter((q) => q.body.dry);
    expect(dry.at(-1)?.body).toMatchObject({
      depositType: "CONFIDENTIAL_INTENTS",
      recipient: EVM,
      swapType: "EXACT_OUTPUT",
      amount: "50000",
    });
    expect(quotes().filter((q) => !q.body.dry)).toEqual([]);
  });

  it("a clean first payment is flagged first_payment and not_contractor_confirmed, neither blocking", async () => {
    const { view } = await inReview();
    expect(view.items[0].flags.map((f: { code: string }) => f.code).sort()).toEqual([
      "first_payment",
      "not_contractor_confirmed",
    ]);
    expect(view.items[0].blocked).toBe(false);
  });

  async function flagsOf(setup: (o: Org) => Promise<string>) {
    const o = await newOrg();
    const contractorId = await setup(o);
    const r = await run(o);
    await addItem(o, r.url, contractorId);
    const view = (await post(`${r.url}/prepare`, o.cookies)).json();
    return view.items[0] as {
      flags: { code: string; blocking: boolean; detail?: string }[];
      blocked: boolean;
    };
  }

  it("an unapproved destination is blocked with its precise reason", async () => {
    const item = await flagsOf(async (o) => (await contractor(o, { approve: false })).contractorId);
    expect(item.flags).toContainEqual({
      code: "destination_not_payable",
      blocking: true,
      detail: "owner_approval_required",
    });
    expect(item.blocked).toBe(true);
  });

  it("no destination at all is blocked", async () => {
    const item = await flagsOf(async (o) => {
      const c = await post(`/orgs/${o.orgId}/contractors`, o.cookies, { name: "Bo", terms: TERMS });
      return c.json().id;
    });
    expect(item.flags).toContainEqual({
      code: "destination_not_payable",
      blocking: true,
      detail: "no_active_destination",
    });
  });

  it("superseded_awaiting_new_head blocks (L29)", async () => {
    const item = await flagsOf(async (o) => {
      const c = await contractor(o);
      await post(`${c.base}/destinations`, o.cookies, { route: "usdc-base", address: EVM_2 });
      return c.contractorId;
    });
    expect(item.flags).toContainEqual({ code: "superseded_awaiting_new_head", blocking: true });
  });

  it("an archived contractor blocks", async () => {
    const item = await flagsOf(async (o) => {
      const c = await contractor(o);
      await post(`${c.base}/archive`, o.cookies);
      return c.contractorId;
    });
    expect(item.flags).toContainEqual({ code: "contractor_archived", blocking: true });
  });

  it("a fee preview that fails blocks", async () => {
    const item = await flagsOf(async (o) => {
      const c = await contractor(o);
      h.one.quoteReject = "Quoting for this pair is not available";
      return c.contractorId;
    });
    expect(item.flags).toContainEqual({ code: "fee_preview_unavailable", blocking: true });
  });

  async function paidBefore(o: Org, contractorId: string, destinationId: string, amount: bigint) {
    const [prev] = await h.db
      .insert(schema.payRuns)
      .values({
        orgId: o.orgId,
        period: "2026-10",
        status: "Completed",
        preparedBy: "user",
        totalAmountUsdc: amount,
        mode: "live",
      })
      .returning();
    const [item] = await h.db
      .insert(schema.payRunItems)
      .values({
        orgId: o.orgId,
        payRunId: prev!.id,
        contractorId,
        destinationId,
        amountUsdc: amount,
        basis: {},
        mode: "live",
      })
      .returning();
    await h.db.insert(schema.payoutAttempts).values({
      orgId: o.orgId,
      lineItemId: item!.id,
      attemptNo: 1,
      status: "SUCCESS",
      mode: "live",
    });
  }

  it("amount deviation above 25% from the last paid amount", async () => {
    const item = await flagsOf(async (o) => {
      const c = await contractor(o);
      await paidBefore(o, c.contractorId, c.destinationId, 30000n);
      return c.contractorId;
    });
    const codes = item.flags.map((f) => f.code);
    expect(codes).toContain("amount_deviation");
    expect(codes).not.toContain("first_payment");
    expect(item.blocked).toBe(false);
  });

  it("a new destination since the last paid run", async () => {
    const item = await flagsOf(async (o) => {
      const c = await contractor(o);
      await paidBefore(o, c.contractorId, c.destinationId, 50000n);
      const next = await post(`${c.base}/destinations`, o.cookies, {
        route: "usdc-base",
        address: EVM_2,
      });
      await approveDestination(o, c.base, next.json().id);
      return c.contractorId;
    });
    expect(item.flags.map((f) => f.code)).toContain("new_destination_since_last_paid");
  });

  it("a simulated success is never counted as a last payment", async () => {
    const item = await flagsOf(async (o) => {
      const c = await contractor(o);
      const [prev] = await h.db
        .insert(schema.payRuns)
        .values({
          orgId: o.orgId,
          period: "2026-10",
          status: "Completed",
          preparedBy: "user",
          totalAmountUsdc: 1n,
          mode: "simulated",
        })
        .returning();
      const [it2] = await h.db
        .insert(schema.payRunItems)
        .values({
          orgId: o.orgId,
          payRunId: prev!.id,
          contractorId: c.contractorId,
          destinationId: c.destinationId,
          amountUsdc: 1n,
          basis: {},
          mode: "simulated",
        })
        .returning();
      await h.db.insert(schema.payoutAttempts).values({
        orgId: o.orgId,
        lineItemId: it2!.id,
        attemptNo: 1,
        status: "SUCCESS",
        mode: "simulated",
      });
      return c.contractorId;
    });
    expect(item.flags.map((f) => f.code)).toContain("first_payment");
  });

  it("review recomputes flags after the owner fixes a payee", async () => {
    const o = await newOrg();
    const c = await contractor(o, { approve: false });
    const r = await run(o);
    await addItem(o, r.url, c.contractorId);
    expect((await post(`${r.url}/prepare`, o.cookies)).json().items[0].blocked).toBe(true);
    await approveDestination(o, c.base, c.destinationId);
    const view = (await post(`${r.url}/review`, o.cookies)).json();
    expect(view.items[0].blocked).toBe(false);
    expect(view.items[0].feePreview).not.toBeNull();
  });
});

describe("approval", () => {
  it("InReview → Quoting, recording the approver, with the funds checked", async () => {
    const { o, r } = await inReview();
    const res = await post(`${r.url}/approve`, o.cookies);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "Quoting",
      funds: { checked: true, available: "500000", needed: "52900" },
    });
    const [row] = await h.db.select().from(schema.payRuns).where(eq(schema.payRuns.id, r.id));
    const me = (await get("/me", o.cookies)).json();
    expect(row?.approvedBy).toBe(me.user.id);
  });

  it("blocking flags prevent approval, naming the items", async () => {
    const o = await newOrg();
    await session(o);
    const good = await contractor(o);
    const bad = await contractor(o, { approve: false, name: "Bo", address: EVM_2 });
    const r = await run(o);
    await addItem(o, r.url, good.contractorId);
    const badItem = await addItem(o, r.url, bad.contractorId);
    await post(`${r.url}/prepare`, o.cookies);
    const res = await post(`${r.url}/approve`, o.cookies);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: "BLOCKING_FLAGS",
      details: { items: [{ itemId: badItem, flags: ["destination_not_payable"] }] },
    });
    expect((await get(r.url, o.cookies)).json().status).toBe("InReview");
  });

  it("a payee revoked after review blocks approval", async () => {
    const { o, r, c } = await inReview();
    await revoke(o, c.approvalId);
    const res = await post(`${r.url}/approve`, o.cookies);
    expect(res.json().error.code).toBe("BLOCKING_FLAGS");
  });

  it("exactly enough approves", async () => {
    const { o, r } = await inReview("live", "497100");
    const res = await post(`${r.url}/approve`, o.cookies);
    expect(res.json()).toMatchObject({ status: "Quoting", funds: { needed: "500000" } });
  });

  it("insufficient funds is refused with the numbers", async () => {
    const { o, r } = await inReview("live", "498000");
    const res = await post(`${r.url}/approve`, o.cookies);
    expect(res.json().error).toMatchObject({
      code: "INSUFFICIENT_FUNDS",
      details: { available: "500000", needed: "500900", shortfall: "900", encumbered: "0" },
    });
  });

  it("with no 1Click session it refuses with needs_session, never a guess", async () => {
    const o = await newOrg();
    const c = await contractor(o);
    const r = await run(o);
    await addItem(o, r.url, c.contractorId);
    await post(`${r.url}/prepare`, o.cookies);
    const res = await post(`${r.url}/approve`, o.cookies);
    expect(res.json().error.code).toBe("NEEDS_SESSION");
  });

  it("only from InReview", async () => {
    const o = await newOrg();
    const r = await run(o);
    expect((await post(`${r.url}/approve`, o.cookies)).json().error.code).toBe("RUN_WRONG_STATUS");
  });

  it("the service check refuses anyone but an active owner (L24)", async () => {
    const o = await newOrg();
    const viewer = await addMember(app, o.cookies, o.orgId, "viewer");
    const owner2 = await addMember(app, o.cookies, o.orgId, "owner");
    await expect(assertApproverIsActiveOwner(h.db, o.orgId, viewer.userId)).rejects.toMatchObject({
      code: "APPROVER_NOT_ACTIVE_OWNER",
    });
    await expect(
      assertApproverIsActiveOwner(h.db, o.orgId, owner2.userId),
    ).resolves.toBeUndefined();
    await h.db
      .update(schema.memberships)
      .set({ status: "removed", removedAt: START })
      .where(eq(schema.memberships.userId, owner2.userId));
    await expect(assertApproverIsActiveOwner(h.db, o.orgId, owner2.userId)).rejects.toMatchObject({
      code: "APPROVER_NOT_ACTIVE_OWNER",
    });
  });
});

describe("payout quotes", () => {
  async function approved(mode: "live" | "simulated" = "live") {
    const s = await inReview(mode);
    expect((await post(`${s.r.url}/approve`, s.o.cookies)).statusCode).toBe(200);
    h.one.requests.length = 0;
    return s;
  }

  it("quotes dry then live with every constraint, stores the attempt, and moves to Signing", async () => {
    const { o, r, itemId } = await approved();
    const res = await post(`${r.url}/quote`, o.cookies);
    expect(res.statusCode).toBe(200);
    const q = quotes();
    expect(q.map((x) => x.body.dry)).toEqual([true, false]);
    expect(q[1]?.body).toMatchObject({
      depositType: "CONFIDENTIAL_INTENTS",
      refundType: "CONFIDENTIAL_INTENTS",
      refundTo: o.wallet.accountId,
      recipient: EVM,
      recipientType: "DESTINATION_CHAIN",
      swapType: "EXACT_OUTPUT",
      amount: "50000",
      deadline: new Date(START.getTime() + 15 * 60_000).toISOString(),
    });
    const view = res.json();
    expect(view.status).toBe("Signing");
    expect(view.readyToSign).toBe("ready_to_sign");
    expect(view.items[0].attempt).toMatchObject({
      attemptNo: 1,
      status: "QUOTED",
      depositAddress: expect.stringMatching(/^payout-/),
      requestedDeadline: new Date(START.getTime() + 15 * 60_000).toISOString(),
      quoteDeadline: "2026-11-09T00:15:00.000Z",
      amountIn: "52900",
      minAmountIn: "52400",
      mode: "live",
    });
    const [row] = await h.db
      .select()
      .from(schema.payoutAttempts)
      .where(eq(schema.payoutAttempts.lineItemId, itemId));
    expect(row?.correlationId).toBeTruthy();
    expect((row?.statusHistory as { status: string }[]).map((x) => x.status)).toEqual([
      "PLANNED",
      "QUOTED",
    ]);
    expect(
      h.one.requests.some(
        (x) => x.path === "/v0/generate-intent" || x.path === "/v0/submit-intent",
      ),
    ).toBe(false);
  });

  it("a payee revoked between approval and quote is blocked: no quote at all (gate B)", async () => {
    const { o, r, c } = await approved();
    await revoke(o, c.approvalId);
    h.one.requests.length = 0;
    const view = (await post(`${r.url}/quote`, o.cookies)).json();
    expect(view.items[0].attempt).toMatchObject({
      status: "FAILED",
      failureReason: "gate_blocked",
    });
    expect(quotes()).toEqual([]);
    expect(view.status).toBe("Quoting");
  });

  it("a quote 1Click didn't sign is refused (gate A), and can be re-quoted as a new attempt", async () => {
    const { o, r } = await approved();
    const other = ed25519.utils.randomSecretKey();
    h.one.signer = (resp) => signQuote(resp, other);
    let view = (await post(`${r.url}/quote`, o.cookies)).json();
    expect(view.items[0].attempt).toMatchObject({
      status: "FAILED",
      failureReason: "quote_rejected",
    });
    expect(quotes().filter((x) => !x.body.dry)).toEqual([]);
    expect(view.status).toBe("Quoting");
    h.one.signer = signQuote;
    view = (await post(`${r.url}/quote`, o.cookies)).json();
    expect(view.items[0].attempt).toMatchObject({ attemptNo: 2, status: "QUOTED" });
    expect(view.status).toBe("Signing");
  });

  it("a signed quote echoing a different recipient is refused", async () => {
    const { o, r } = await approved();
    h.one.echoChange = { recipient: EVM_2 };
    const view = (await post(`${r.url}/quote`, o.cookies)).json();
    expect(view.items[0].attempt).toMatchObject({
      status: "FAILED",
      failureReason: "quote_rejected",
    });
  });

  it("a quote 1Click refuses fails that item only, with quote_rejected", async () => {
    const o = await newOrg();
    await session(o);
    const a = await contractor(o);
    const b = await contractor(o, { name: "Bo", address: EVM_2 });
    const r = await run(o);
    const ia = await addItem(o, r.url, a.contractorId);
    await addItem(o, r.url, b.contractorId);
    await post(`${r.url}/prepare`, o.cookies);
    await post(`${r.url}/approve`, o.cookies);
    h.one.quoteReject = "recipient is not valid";
    await post(`${r.url}/quote`, o.cookies, { itemIds: [ia] });
    h.one.quoteReject = "";
    const view = (await post(`${r.url}/quote`, o.cookies)).json();
    const byId = Object.fromEntries(view.items.map((i: { id: string }) => [i.id, i]));
    expect(byId[ia].attempt).toMatchObject({ attemptNo: 2, status: "QUOTED" });
    expect(view.status).toBe("Signing");
  });

  it("an item already quoted isn't quoted again", async () => {
    const { o, r } = await approved();
    await post(`${r.url}/quote`, o.cookies);
    h.one.requests.length = 0;
    // The run is in Signing now, so the route refuses outright.
    expect((await post(`${r.url}/quote`, o.cookies)).json().error.code).toBe("RUN_WRONG_STATUS");
    expect(quotes()).toEqual([]);
  });

  it("only from Quoting", async () => {
    const { o, r } = await inReview();
    expect((await post(`${r.url}/quote`, o.cookies)).json().error.code).toBe("RUN_WRONG_STATUS");
  });
});

describe("simulated mode (L7)", () => {
  it("runs the whole flow with dry quotes only, needs no session, and stops at ready-to-sign", async () => {
    const o = await newOrg();
    const c = await contractor(o);
    const r = await run(o, "simulated");
    await addItem(o, r.url, c.contractorId);
    h.one.requests.length = 0;
    await post(`${r.url}/prepare`, o.cookies);
    const approvedRes = await post(`${r.url}/approve`, o.cookies);
    expect(approvedRes.json()).toMatchObject({ status: "Quoting", funds: { checked: false } });
    const view = (await post(`${r.url}/quote`, o.cookies)).json();
    expect(view).toMatchObject({
      status: "Signing",
      simulated: true,
      readyToSign: "ready_to_sign_simulated",
      label: expect.stringContaining("SIMULATED"),
    });
    expect(view.items[0].attempt).toMatchObject({
      status: "QUOTED",
      mode: "simulated",
      depositAddress: null,
    });
    const paths = h.one.requests.map((x) => x.path);
    expect(paths.every((p) => p === "/v0/quote")).toBe(true);
    expect(quotes().every((x) => x.body.dry === true)).toBe(true);
    expect(paths).not.toContain("/v0/account/balances");
  });

  it("never records a success", async () => {
    const o = await newOrg();
    const c = await contractor(o);
    const r = await run(o, "simulated");
    await addItem(o, r.url, c.contractorId);
    await post(`${r.url}/prepare`, o.cookies);
    await post(`${r.url}/approve`, o.cookies);
    await post(`${r.url}/quote`, o.cookies);
    const rows = await h.db
      .select()
      .from(schema.payoutAttempts)
      .where(eq(schema.payoutAttempts.orgId, o.orgId));
    expect(rows.every((x) => x.mode === "simulated" && x.status !== "SUCCESS")).toBe(true);
  });
});

describe("rate limits and audit", () => {
  it("quote and approve are limited per org and user", async () => {
    const limited = await h.build({
      config: {
        authRecipient: RECIPIENT,
        webOrigin: "https://app.veylo.test",
        sessionTtlHours: 24,
        logLevel: "silent",
        treasuryLimitPerOrgPerHour: 1,
        treasuryLimitPerUserPerHour: 1,
      },
    });
    const owner = await signIn(limited);
    const org = await createOrg(limited, owner.cookies);
    const r = (
      await limited.inject({
        method: "POST",
        url: `/orgs/${org.id}/pay-runs`,
        cookies: owner.cookies,
        payload: { period: "2026-11", mode: "simulated" },
      })
    ).json();
    const url = `/orgs/${org.id}/pay-runs/${r.id}`;
    const hit = (path: string) =>
      limited.inject({ method: "POST", url: `${url}/${path}`, cookies: owner.cookies });
    expect((await hit("approve")).statusCode).toBe(409);
    expect((await hit("approve")).json().error.code).toBe("RATE_LIMITED");
    expect((await hit("quote")).statusCode).toBe(409);
    expect((await hit("quote")).json().error.code).toBe("RATE_LIMITED");
    await limited.close();
  });

  it("every run transition is audited", async () => {
    const { o, r } = await inReview();
    await post(`${r.url}/approve`, o.cookies);
    await post(`${r.url}/quote`, o.cookies);
    const actions = await audit(o.orgId);
    for (const a of [
      "pay_run.draft",
      "pay_run.item_add",
      "pay_run.prepared",
      "pay_run.inreview",
      "pay_run.quoting",
      "pay_run.signing",
    ]) {
      expect(actions).toContain(a);
    }
  });
});

void randomBytes;
