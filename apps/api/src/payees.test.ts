import { schema } from "@veylo/db";
import { eq } from "drizzle-orm";
import { base64 } from "@scure/base";
import {
  buildApprovalMessage,
  sha256Text,
  verifyPayeeApproval,
  verifyRegistryHead,
  payeeSetHash,
} from "@veylo/intents";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  challenge,
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
beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});
beforeEach(() => {
  h.quote.respond = h.quote.accepted;
  h.rpcHooks.before = undefined;
  h.rpcHooks.fail = false;
  h.clock.now = new Date("2026-11-06T10:00:00.000Z");
});

const EVM = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
const EVM_2 = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const TERMS = { kind: "fixed", rate: "1", schedule: "monthly" };

type Req = {
  requestId: string;
  approvalMessage: string;
  approvalNonce: string;
  headMessage: string;
  headNonce: string;
  recipient: string;
  expiresAt: string;
};
type Cookies = Record<string, string>;

async function newOrg(wallet = new Wallet()) {
  const owner = await signIn(app, wallet);
  const org = await createOrg(app, owner.cookies);
  return { wallet, cookies: owner.cookies, orgId: org.id };
}

async function newContractor(orgId: string, cookies: Cookies, name = "Ada") {
  const res = await app.inject({
    method: "POST",
    url: `/orgs/${orgId}/contractors`,
    cookies,
    payload: { name, terms: TERMS },
  });
  return res.json().id as string;
}

async function newDestination(base: string, cookies: Cookies, address = EVM) {
  const res = await app.inject({
    method: "POST",
    url: `${base}/destinations`,
    cookies,
    payload: { route: "usdc-base", address },
  });
  return res.json().id as string;
}

async function setup(wallet?: Wallet) {
  const org = await newOrg(wallet);
  const contractorId = await newContractor(org.orgId, org.cookies);
  const base = `/orgs/${org.orgId}/contractors/${contractorId}`;
  const destinationId = await newDestination(base, org.cookies);
  return { ...org, contractorId, base, destinationId };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function request(s: Pick<Setup, "base" | "cookies">, destinationId: string) {
  const res = await app.inject({
    method: "POST",
    url: `${s.base}/destinations/${destinationId}/approval-request`,
    cookies: s.cookies,
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json() as Req;
}

const body = (r: Req, wallet: Wallet) => ({
  accountId: wallet.accountId,
  publicKey: wallet.publicKey,
  approvalSignature: wallet.sign(r.approvalMessage, r.approvalNonce, RECIPIENT),
  headSignature: wallet.sign(r.headMessage, r.headNonce, RECIPIENT),
});

const complete = (
  s: Pick<Setup, "base" | "cookies">,
  destinationId: string,
  r: Req,
  payload: object,
) =>
  app.inject({
    method: "POST",
    url: `${s.base}/destinations/${destinationId}/approval-request/${r.requestId}/complete`,
    cookies: s.cookies,
    payload,
  });

async function approve(s: Setup, destinationId = s.destinationId) {
  const r = await request(s, destinationId);
  const res = await complete(s, destinationId, r, body(r, s.wallet));
  if (res.statusCode !== 200) throw new Error(res.body);
  return { r, approvalId: res.json().approvalId as string };
}

const registry = async (orgId: string, cookies: Cookies) =>
  (await app.inject({ method: "GET", url: `/orgs/${orgId}/payee-registry`, cookies })).json();

async function destinationView(s: Setup, id = s.destinationId) {
  const res = await app.inject({
    method: "GET",
    url: `${s.base}/destinations`,
    cookies: s.cookies,
  });
  return (
    res.json().destinations as { id: string; payable: boolean; payableReason: string }[]
  ).find((d) => d.id === id);
}

async function revoke(s: Setup, approvalId: string, wallet = s.wallet) {
  const res = await app.inject({
    method: "POST",
    url: `/orgs/${s.orgId}/payees/${approvalId}/revoke-request`,
    cookies: s.cookies,
  });
  const r = res.json() as Req;
  return app.inject({
    method: "POST",
    url: `/orgs/${s.orgId}/payees/${approvalId}/revoke-request/${r.requestId}/complete`,
    cookies: s.cookies,
    payload: {
      accountId: wallet.accountId,
      publicKey: wallet.publicKey,
      headSignature: wallet.sign(r.headMessage, r.headNonce, RECIPIENT),
    },
  });
}

const rows = (orgId: string) =>
  Promise.all([
    h.db.select().from(schema.payeeApprovals).where(eq(schema.payeeApprovals.orgId, orgId)),
    h.db.select().from(schema.payeeRegistryHeads).where(eq(schema.payeeRegistryHeads.orgId, orgId)),
  ]);

const REJECTED = "PAYEE_SIGNER_REJECTED";
async function expectNothingStored(orgId: string) {
  const [approvals, heads] = await rows(orgId);
  expect(approvals).toEqual([]);
  expect(heads).toEqual([]);
}

describe("approval-request", () => {
  it("returns both messages, two different 32-byte nonces, the recipient and a 10-minute expiry", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    expect(r.recipient).toBe(RECIPIENT);
    expect(base64.decode(r.approvalNonce)).toHaveLength(32);
    expect(base64.decode(r.headNonce)).toHaveLength(32);
    expect(r.approvalNonce).not.toBe(r.headNonce);
    expect(new Date(r.expiresAt).getTime()).toBe(h.clock.now.getTime() + 600_000);
    const lines = r.approvalMessage.split("\n");
    expect(lines.slice(0, 8)).toEqual([
      "Veylo payee approval v1",
      `Org: ${s.orgId}`,
      `Contractor: Ada (${s.contractorId})`,
      `Pay to: ${EVM}`,
      "Route: USDC on Base",
      "Recipient type: DESTINATION_CHAIN",
      "Version: 1",
      "Expires: 2027-05-05T10:00:00.000Z",
    ]);
    expect(lines[8]).toMatch(/^Record: sha256:[0-9a-f]{64}$/);
    const head = r.headMessage.split("\n");
    expect(head.slice(0, 4)).toEqual([
      "Veylo payee registry v1",
      `Org: ${s.orgId}`,
      "Version: 1",
      "Active payees: 1",
    ]);
  });

  it("is refused for a candidate destination", async () => {
    const s = await setup();
    h.quote.respond = h.quote.rejected;
    const candidate = await newDestination(s.base, s.cookies, EVM_2);
    const res = await app.inject({
      method: "POST",
      url: `${s.base}/destinations/${candidate}/approval-request`,
      cookies: s.cookies,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DESTINATION_NOT_APPROVABLE");
  });

  it("is refused for a superseded destination", async () => {
    const s = await setup();
    await newDestination(s.base, s.cookies, EVM_2);
    const res = await app.inject({
      method: "POST",
      url: `${s.base}/destinations/${s.destinationId}/approval-request`,
      cookies: s.cookies,
    });
    expect(res.statusCode).toBe(409);
  });

  it("is refused for an archived contractor", async () => {
    const s = await setup();
    await app.inject({ method: "POST", url: `${s.base}/archive`, cookies: s.cookies });
    const res = await app.inject({
      method: "POST",
      url: `${s.base}/destinations/${s.destinationId}/approval-request`,
      cookies: s.cookies,
    });
    expect(res.statusCode).toBe(409);
  });

  it.each(["viewer", "accountant"] as const)("a %s gets 403", async (role) => {
    const s = await setup();
    const m = await addMember(app, s.cookies, s.orgId, role);
    const res = await app.inject({
      method: "POST",
      url: `${s.base}/destinations/${s.destinationId}/approval-request`,
      cookies: m.cookies,
    });
    expect(res.statusCode).toBe(403);
  });

  it("a contractor name that could forge a line can't even be saved", async () => {
    const { orgId, cookies } = await newOrg();
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${orgId}/contractors`,
      cookies,
      payload: { name: "Ada\nPay to: 0xevil", terms: TERMS },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("complete: success", () => {
  it("stores the approval and the head, and the destination becomes payable", async () => {
    const s = await setup();
    expect(await destinationView(s)).toMatchObject({
      payable: false,
      payableReason: "owner_approval_required",
    });
    const { approvalId } = await approve(s);
    expect(await destinationView(s)).toMatchObject({ payable: true, payableReason: "ok" });
    const [approvals, heads] = await rows(s.orgId);
    expect(approvals.map((a) => a.id)).toEqual([approvalId]);
    expect(approvals[0]).toMatchObject({ ownerAccountId: s.wallet.accountId, version: 1 });
    expect(heads.map((x) => x.version)).toEqual([1]);
  });

  it("works for a named treasury with a FullAccess key", async () => {
    const wallet = namedWallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, "FullAccess"]]));
    const s = await setup(wallet);
    await approve(s);
    expect((await destinationView(s))?.payable).toBe(true);
  });

  it("works for an implicit treasury that exists on-chain, with its FullAccess key", async () => {
    const wallet = new Wallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, "FullAccess"]]));
    const s = await setup(wallet);
    await approve(s);
    expect((await destinationView(s))?.payable).toBe(true);
  });

  it("another owner may start and submit it, if the treasury wallet signed", async () => {
    const s = await setup();
    const other = await addMember(app, s.cookies, s.orgId, "owner");
    const viaOther = { base: s.base, cookies: other.cookies };
    const r = await request(viaOther, s.destinationId);
    const res = await complete(viaOther, s.destinationId, r, body(r, s.wallet));
    expect(res.statusCode).toBe(200);
  });

  it("a later head's version increases, and re-approval bumps the record version", async () => {
    const s = await setup();
    await approve(s);
    const second = await approve(s);
    expect(second.r.approvalMessage).toContain("Version: 2");
    expect(second.r.headMessage).toContain("Version: 2");
    expect(second.r.headMessage).toContain("Active payees: 1");
    const reg = await registry(s.orgId, s.cookies);
    expect(reg.approvals).toHaveLength(1);
    expect(reg.approvals[0].version).toBe(2);
  });
});

describe("wrong signer (L28)", () => {
  it("an owner who isn't the treasury account", async () => {
    const s = await setup();
    const other = await addMember(app, s.cookies, s.orgId, "owner");
    const r = await request(s, s.destinationId);
    const res = await complete(s, s.destinationId, r, body(r, other.wallet));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(REJECTED);
    await expectNothingStored(s.orgId);
  });

  it("a non-member's key claiming to be the treasury", async () => {
    const s = await setup();
    const stranger = new Wallet();
    const r = await request(s, s.destinationId);
    const res = await complete(s, s.destinationId, r, {
      ...body(r, stranger),
      accountId: s.wallet.accountId,
    });
    expect(res.json().error.code).toBe(REJECTED);
    await expectNothingStored(s.orgId);
  });

  it("a non-member signing as themselves", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    const res = await complete(s, s.destinationId, r, body(r, new Wallet()));
    expect(res.json().error.code).toBe(REJECTED);
  });

  it("the treasury account after it was removed as an owner", async () => {
    const s = await setup();
    const other = await addMember(app, s.cookies, s.orgId, "owner");
    const viaOther = { base: s.base, cookies: other.cookies };
    // The routes refuse this now (L30), so this simulates a tampered database.
    const me = await app.inject({ method: "GET", url: "/me", cookies: s.cookies });
    await h.db
      .update(schema.memberships)
      .set({ status: "removed", removedAt: h.clock.now })
      .where(eq(schema.memberships.userId, me.json().user.id));
    const r = await request(viaOther, s.destinationId);
    const res = await complete(viaOther, s.destinationId, r, body(r, s.wallet));
    expect(res.json().error.code).toBe(REJECTED);
  });

  it("the treasury account demoted to viewer", async () => {
    const s = await setup();
    const other = await addMember(app, s.cookies, s.orgId, "owner");
    const viaOther = { base: s.base, cookies: other.cookies };
    const me = await app.inject({ method: "GET", url: "/me", cookies: s.cookies });
    await h.db
      .update(schema.memberships)
      .set({ role: "viewer" })
      .where(eq(schema.memberships.userId, me.json().user.id));
    const r = await request(viaOther, s.destinationId);
    const res = await complete(viaOther, s.destinationId, r, body(r, s.wallet));
    expect(res.json().error.code).toBe(REJECTED);
  });

  it("a function-call key of a named treasury", async () => {
    const wallet = namedWallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, "FullAccess"]]));
    const s = await setup(wallet);
    h.chain.set(
      wallet.accountId,
      new Map([[wallet.publicKey, { FunctionCall: { allowance: null, method_names: [] } }]]),
    );
    const r = await request(s, s.destinationId);
    const res = await complete(s, s.destinationId, r, body(r, wallet));
    expect(res.json().error.code).toBe(REJECTED);
    await expectNothingStored(s.orgId);
  });

  it("a rotated-out key of an implicit treasury that exists on-chain", async () => {
    const s = await setup();
    h.chain.set(s.wallet.accountId, new Map([["ed25519:new", "FullAccess"]]));
    const r = await request(s, s.destinationId);
    const res = await complete(s, s.destinationId, r, body(r, s.wallet));
    expect(res.json().error.code).toBe(REJECTED);
    h.chain.delete(s.wallet.accountId);
  });

  it("RPC down fails closed", async () => {
    const wallet = namedWallet();
    h.chain.set(wallet.accountId, new Map([[wallet.publicKey, "FullAccess"]]));
    const s = await setup(wallet);
    const r = await request(s, s.destinationId);
    h.rpcHooks.fail = true;
    const res = await complete(s, s.destinationId, r, body(r, wallet));
    expect(res.json().error.code).toBe(REJECTED);
    await expectNothingStored(s.orgId);
  });
});

describe("tampered signatures", () => {
  const LINES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  it.each(LINES)("approval message line %i changed before signing", async (i) => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    const lines = r.approvalMessage.split("\n");
    lines[i] = `${lines[i]}x`;
    const res = await complete(s, s.destinationId, r, {
      ...body(r, s.wallet),
      approvalSignature: s.wallet.sign(lines.join("\n"), r.approvalNonce, RECIPIENT),
    });
    expect(res.json().error.code).toBe(REJECTED);
    await expectNothingStored(s.orgId);
  });

  it.each([0, 1, 2, 3, 4, 5])("head message line %i changed before signing", async (i) => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    const lines = r.headMessage.split("\n");
    lines[i] = `${lines[i]}x`;
    const res = await complete(s, s.destinationId, r, {
      ...body(r, s.wallet),
      headSignature: s.wallet.sign(lines.join("\n"), r.headNonce, RECIPIENT),
    });
    expect(res.json().error.code).toBe(REJECTED);
    await expectNothingStored(s.orgId);
  });

  it("swapped signatures, wrong nonce, wrong recipient", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    const good = body(r, s.wallet);
    for (const payload of [
      { ...good, approvalSignature: good.headSignature, headSignature: good.approvalSignature },
      {
        ...good,
        approvalSignature: s.wallet.sign(r.approvalMessage, r.headNonce, RECIPIENT),
      },
      { ...good, headSignature: s.wallet.sign(r.headMessage, r.approvalNonce, RECIPIENT) },
      {
        ...good,
        approvalSignature: s.wallet.sign(r.approvalMessage, r.approvalNonce, "intents.near"),
      },
    ]) {
      const res = await complete(s, s.destinationId, r, payload);
      expect(res.json().error.code).toBe(REJECTED);
    }
    await expectNothingStored(s.orgId);
  });

  it("a rejected attempt doesn't spend the request", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    await complete(s, s.destinationId, r, body(r, new Wallet()));
    expect((await complete(s, s.destinationId, r, body(r, s.wallet))).statusCode).toBe(200);
  });
});

describe("domain separation", () => {
  it("a sign-in signature can't complete an approval or head", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    const c = await challenge(app, s.wallet.accountId);
    const signIn2 = s.wallet.sign(c.message, c.nonce, RECIPIENT);
    const res = await complete(s, s.destinationId, r, {
      ...body(r, s.wallet),
      approvalSignature: signIn2,
    });
    expect(res.json().error.code).toBe(REJECTED);
    const res2 = await complete(s, s.destinationId, r, {
      ...body(r, s.wallet),
      headSignature: signIn2,
    });
    expect(res2.json().error.code).toBe(REJECTED);
  });

  it("an approval or head signature can't sign in, even reusing its nonce", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    const c = await challenge(app, s.wallet.accountId);
    const attempt = (signature: string) =>
      app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: {
          accountId: s.wallet.accountId,
          publicKey: s.wallet.publicKey,
          signature,
          nonce: c.nonce,
        },
      });
    const asApproval = s.wallet.sign(r.approvalMessage, c.nonce, RECIPIENT);
    const asHead = s.wallet.sign(r.headMessage, c.nonce, RECIPIENT);
    expect((await attempt(asApproval)).statusCode).toBe(401);
    expect((await attempt(asHead)).statusCode).toBe(401);
  });
});

describe("request lifetime", () => {
  it("nonce replay: a completed request can't run again", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    expect((await complete(s, s.destinationId, r, body(r, s.wallet))).statusCode).toBe(200);
    const again = await complete(s, s.destinationId, r, body(r, s.wallet));
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("REQUEST_USED");
    const [approvals, heads] = await rows(s.orgId);
    expect([approvals.length, heads.length]).toEqual([1, 1]);
  });

  it("an expired request, including at the exact moment", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    h.clock.now = new Date(h.clock.now.getTime() + 600_000);
    const res = await complete(s, s.destinationId, r, body(r, s.wallet));
    expect(res.json().error.code).toBe("REQUEST_EXPIRED");
    await expectNothingStored(s.orgId);
  });

  it("a stale head version, rejected before any RPC call", async () => {
    const s = await setup();
    const second = await newContractor(s.orgId, s.cookies, "Bo");
    const viaSecond = { base: `/orgs/${s.orgId}/contractors/${second}`, cookies: s.cookies };
    const dest2 = await newDestination(viaSecond.base, s.cookies, EVM_2);
    const stale = await request(s, s.destinationId);
    const fresh = await request(viaSecond, dest2);
    expect((await complete(viaSecond, dest2, fresh, body(fresh, s.wallet))).statusCode).toBe(200);
    const calls = h.rpcHooks.calls;
    const res = await complete(s, s.destinationId, stale, body(stale, s.wallet));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("STALE_HEAD");
    expect(h.rpcHooks.calls).toBe(calls);
  });

  it("a destination superseded after the request can't be approved", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    await newDestination(s.base, s.cookies, EVM_2);
    const res = await complete(s, s.destinationId, r, body(r, s.wallet));
    expect(res.json().error.code).toBe("DESTINATION_NOT_APPROVABLE");
    await expectNothingStored(s.orgId);
    const [row] = await h.db
      .select()
      .from(schema.payeeRequests)
      .where(eq(schema.payeeRequests.id, r.requestId));
    expect(row?.usedAt).toBeNull();
  });

  it("a request can't complete through another destination's path", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    const res = await complete(s, "00000000-0000-4000-8000-000000000000", r, body(r, s.wallet));
    expect(res.statusCode).toBe(404);
  });
});

/** Holds requests at the RPC call until both have passed every check made before the transaction. */
function barrier() {
  let arrived = 0;
  let release: () => void = () => {};
  const both = new Promise<void>((resolve) => (release = resolve));
  h.rpcHooks.before = async () => {
    arrived += 1;
    if (arrived === 2) release();
    await both;
  };
}

describe("concurrent completion", () => {
  it("two requests for the same head version: exactly one wins, and the loser leaves nothing", async () => {
    const s = await setup();
    const second = await newContractor(s.orgId, s.cookies, "Bo");
    const viaSecond = { base: `/orgs/${s.orgId}/contractors/${second}`, cookies: s.cookies };
    const dest2 = await newDestination(viaSecond.base, s.cookies, EVM_2);
    const a = await request(s, s.destinationId);
    const b = await request(viaSecond, dest2);
    barrier();
    const results = await Promise.all([
      complete(s, s.destinationId, a, body(a, s.wallet)),
      complete(viaSecond, dest2, b, body(b, s.wallet)),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.statusCode === 409);
    expect(loser?.json().error.code).toBe("STALE_HEAD");

    const [approvals, heads] = await rows(s.orgId);
    expect(approvals).toHaveLength(1);
    expect(heads.map((x) => x.version)).toEqual([1]);
    // Atomic: the loser's request wasn't spent.
    const used = await h.db
      .select()
      .from(schema.payeeRequests)
      .where(eq(schema.payeeRequests.orgId, s.orgId));
    expect(used.filter((u) => u.usedAt !== null)).toHaveLength(1);
  });

  it("the same request twice: exactly one wins", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    barrier();
    const results = await Promise.all([
      complete(s, s.destinationId, r, body(r, s.wallet)),
      complete(s, s.destinationId, r, body(r, s.wallet)),
    ]);
    expect(results.map((x) => x.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((x) => x.statusCode === 409)?.json().error.code).toBe("REQUEST_USED");
    const [approvals, heads] = await rows(s.orgId);
    expect([approvals.length, heads.length]).toEqual([1, 1]);
  });
});

describe("expiry after 180 days", () => {
  const DAY = 86_400_000;
  const look = async (s: Setup, days: number) => {
    h.clock.now = new Date(new Date("2026-11-06T10:00:00.000Z").getTime() + days * DAY);
    const fresh = await signIn(app, s.wallet);
    return destinationView({ ...s, cookies: fresh.cookies });
  };

  it("payable through day 179, and not at day 180", async () => {
    const s = await setup();
    await approve(s);
    expect((await look(s, 179))?.payable).toBe(true);
    expect(await look(s, 180)).toMatchObject({ payable: false, payableReason: "approval_expired" });
  });

  it("re-approval restores it", async () => {
    const s = await setup();
    await approve(s);
    await look(s, 180);
    const fresh = await signIn(app, s.wallet);
    await approve({ ...s, cookies: fresh.cookies });
    expect((await look(s, 180))?.payable).toBe(true);
  });
});

describe("revocation", () => {
  it("removes it from a new head, sets revoked_at, and blocks payment", async () => {
    const s = await setup();
    const { approvalId } = await approve(s);
    const res = await revoke(s, approvalId);
    expect(res.statusCode).toBe(200);
    expect(await destinationView(s)).toMatchObject({
      payable: false,
      payableReason: "approval_revoked",
    });
    const [approvals, heads] = await rows(s.orgId);
    expect(approvals[0]?.revokedAt).toEqual(h.clock.now);
    expect(heads.map((x) => x.version).sort()).toEqual([1, 2]);
    const reg = await registry(s.orgId, s.cookies);
    expect(reg.head.version).toBe(2);
    expect(reg.head.recordHashes).toEqual([]);
    expect(reg.head.message).toContain("Active payees: 0");
    expect(reg.approvals).toEqual([]);
  });

  it("needs the treasury signer", async () => {
    const s = await setup();
    const { approvalId } = await approve(s);
    const other = await addMember(app, s.cookies, s.orgId, "owner");
    const res = await revoke(s, approvalId, other.wallet);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(REJECTED);
    expect((await destinationView(s))?.payable).toBe(true);
  });

  it("can't be repeated", async () => {
    const s = await setup();
    const { approvalId } = await approve(s);
    await revoke(s, approvalId);
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${s.orgId}/payees/${approvalId}/revoke-request`,
      cookies: s.cookies,
    });
    expect(res.json().error.code).toBe("ALREADY_REVOKED");
  });

  it("keeps other payees in the set", async () => {
    const s = await setup();
    const { approvalId } = await approve(s);
    const c2 = await newContractor(s.orgId, s.cookies, "Bo");
    const s2 = { ...s, base: `/orgs/${s.orgId}/contractors/${c2}`, contractorId: c2 };
    const d2 = await newDestination(s2.base, s.cookies, EVM_2);
    await approve(s2, d2);
    await revoke(s, approvalId);
    const reg = await registry(s.orgId, s.cookies);
    expect(reg.approvals.map((a: { destinationId: string }) => a.destinationId)).toEqual([d2]);
    expect((await destinationView(s2, d2))?.payable).toBe(true);
  });

  it("a revoked approval can be replaced by re-approving", async () => {
    const s = await setup();
    const { approvalId } = await approve(s);
    await revoke(s, approvalId);
    await approve(s);
    expect((await destinationView(s))?.payable).toBe(true);
  });
});

describe("a superseded destination", () => {
  it("isn't payable at once, and leaves the set at the next approval", async () => {
    const s = await setup();
    await approve(s);
    const next = await newDestination(s.base, s.cookies, EVM_2);
    // L29: while the old record is still signed into the head, the whole contractor is blocked.
    for (const id of [s.destinationId, next]) {
      expect(await destinationView(s, id)).toMatchObject({
        payable: false,
        payableReason: "superseded_awaiting_new_head",
      });
    }
    const { r } = await approve(s, next);
    expect(r.headMessage).toContain("Active payees: 1");
    const reg = await registry(s.orgId, s.cookies);
    expect(reg.approvals.map((a: { destinationId: string }) => a.destinationId)).toEqual([next]);
    expect((await destinationView(s, next))?.payable).toBe(true);
    expect((await destinationView(s))?.payableReason).toBe("destination_superseded");
  });

  it("another contractor isn't blocked by it", async () => {
    const s = await setup();
    const c2 = await newContractor(s.orgId, s.cookies, "Bo");
    const s2 = { ...s, base: `/orgs/${s.orgId}/contractors/${c2}`, contractorId: c2 };
    const d2 = await newDestination(s2.base, s.cookies, EVM_2);
    await approve(s2, d2);
    await approve(s);
    await newDestination(s.base, s.cookies, EVM_2);
    expect((await destinationView(s))?.payableReason).toBe("superseded_awaiting_new_head");
    expect((await destinationView(s2, d2))?.payable).toBe(true);
  });

  it("a new head from revoking the old approval also clears it", async () => {
    const s = await setup();
    const { approvalId } = await approve(s);
    const next = await newDestination(s.base, s.cookies, EVM_2);
    expect((await revoke(s, approvalId)).statusCode).toBe(200);
    expect((await destinationView(s, next))?.payableReason).toBe("owner_approval_required");
  });

  it("another contractor's superseded destination is left alone", async () => {
    const s = await setup();
    await approve(s);
    await newDestination(s.base, s.cookies, EVM_2);
    const c2 = await newContractor(s.orgId, s.cookies, "Bo");
    const s2 = { ...s, base: `/orgs/${s.orgId}/contractors/${c2}`, contractorId: c2 };
    const d2 = await newDestination(s2.base, s.cookies, EVM);
    const { r } = await approve(s2, d2);
    expect(r.headMessage).toContain("Active payees: 2");
  });
});

describe("other payable states", () => {
  it("an archived contractor", async () => {
    const s = await setup();
    await approve(s);
    await app.inject({ method: "POST", url: `${s.base}/archive`, cookies: s.cookies });
    expect((await destinationView(s))?.payableReason).toBe("contractor_archived");
  });

  it("a row signed by anyone but the treasury account", async () => {
    const s = await setup();
    await approve(s);
    await h.db.delete(schema.payeeRequests).where(eq(schema.payeeRequests.orgId, s.orgId));
    const [approval] = await h.db
      .select()
      .from(schema.payeeApprovals)
      .where(eq(schema.payeeApprovals.orgId, s.orgId));
    // Simulates a tampered database (T-2): a treasury changed under an existing approval.
    await h.db
      .update(schema.treasuries)
      .set({ nearAccountId: "someone-else.near" })
      .where(eq(schema.treasuries.orgId, s.orgId));
    expect(approval?.ownerAccountId).toBe(s.wallet.accountId);
    expect((await destinationView(s))?.payableReason).toBe("approval_signer_not_treasury");
  });

  it("an approval missing from the head", async () => {
    const s = await setup();
    await approve(s);
    const other = await setup();
    await approve(other);
    const [, heads] = await rows(s.orgId);
    expect(heads).toHaveLength(1);
    await h.db.execute(`ALTER TABLE payee_registry_heads DISABLE TRIGGER USER` as never);
    await h.db
      .update(schema.payeeRegistryHeads)
      .set({ payload: { recordHashes: [] } })
      .where(eq(schema.payeeRegistryHeads.orgId, s.orgId));
    await h.db.execute(`ALTER TABLE payee_registry_heads ENABLE TRIGGER USER` as never);
    expect((await destinationView(s))?.payableReason).toBe("not_in_registry_head");
  });
});

describe("GET payee-registry", () => {
  it("is empty before any approval", async () => {
    const { orgId, cookies } = await newOrg();
    expect(await registry(orgId, cookies)).toEqual({ head: null, approvals: [] });
  });

  it("any member can read it", async () => {
    const s = await setup();
    await approve(s);
    const viewer = await addMember(app, s.cookies, s.orgId, "viewer");
    expect((await registry(s.orgId, viewer.cookies)).head.version).toBe(1);
  });

  it("gives the browser enough to verify everything independently", async () => {
    const s = await setup();
    await approve(s);
    const reg = await registry(s.orgId, s.cookies);
    const a = reg.approvals[0];
    const parsed = JSON.parse(a.canonicalRecord);
    expect(sha256Text(a.canonicalRecord)).toBe(a.recordHash);
    expect(reg.head.recordHashes).toEqual([a.recordHash]);
    expect(reg.head.activeSetHash).toBe(payeeSetHash([a.recordHash]));
    expect(
      verifyPayeeApproval({
        record: {
          orgId: parsed.orgId,
          contractorId: parsed.contractorId,
          destinationId: parsed.destinationId,
          routeId: parsed.routeId,
          recipient: parsed.recipient,
          recipientType: parsed.recipientType,
          version: 1,
          approvedAt: new Date(parsed.approvedAt),
          expiresAt: new Date(parsed.expiresAt),
        },
        contractorName: "Ada",
        routeLabel: "USDC on Base",
        nonce: base64.decode(a.nonce),
        recipient: a.recipient,
        publicKey: a.ownerPublicKey,
        signature: a.signature,
      }),
    ).toBe(true);
    expect(
      verifyRegistryHead({
        orgId: s.orgId,
        version: 1,
        recordHashes: reg.head.recordHashes,
        signedAt: new Date(reg.head.signedAt),
        nonce: base64.decode(reg.head.nonce),
        recipient: reg.head.recipient,
        publicKey: reg.head.ownerPublicKey,
        signature: reg.head.signature,
      }),
    ).toBe(true);
  });
});

describe("the signed message is stored", () => {
  it("recomputing from the record plus the name reproduces the stored text", async () => {
    const s = await setup();
    await approve(s);
    const reg = await registry(s.orgId, s.cookies);
    const a = reg.approvals[0];
    expect(a.contractorName).toBe("Ada");
    const parsed = JSON.parse(a.canonicalRecord);
    expect(
      buildApprovalMessage({
        record: {
          orgId: parsed.orgId,
          contractorId: parsed.contractorId,
          destinationId: parsed.destinationId,
          routeId: parsed.routeId,
          recipient: parsed.recipient,
          recipientType: parsed.recipientType,
          version: 1,
          approvedAt: new Date(parsed.approvedAt),
          expiresAt: new Date(parsed.expiresAt),
        },
        contractorName: a.contractorName,
        routeLabel: "USDC on Base",
      }),
    ).toBe(a.message);
  });

  it("keeps the name as signed after a rename", async () => {
    const s = await setup();
    await approve(s);
    await app.inject({
      method: "PATCH",
      url: s.base,
      cookies: s.cookies,
      payload: { name: "New" },
    });
    const a = (await registry(s.orgId, s.cookies)).approvals[0];
    expect(a.contractorName).toBe("Ada");
    expect(a.message).toContain("Contractor: Ada (");
  });
});

describe("audit", () => {
  it("records approval and revocation, with no signature", async () => {
    const s = await setup();
    const { approvalId } = await approve(s);
    await revoke(s, approvalId);
    const entries = await h.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.orgId, s.orgId));
    const payee = entries.filter((e) => e.action.startsWith("payee."));
    expect(payee.map((e) => e.action).sort()).toEqual(["payee.approve", "payee.revoke"]);
    expect(payee.every((e) => e.entityId === approvalId)).toBe(true);
    const [approvals] = await rows(s.orgId);
    expect(JSON.stringify(entries)).not.toContain(approvals[0]?.signature);
  });

  it("a rejected attempt records nothing", async () => {
    const s = await setup();
    const r = await request(s, s.destinationId);
    await complete(s, s.destinationId, r, body(r, new Wallet()));
    const entries = await h.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.orgId, s.orgId));
    expect(entries.filter((e) => e.action.startsWith("payee."))).toEqual([]);
  });
});
