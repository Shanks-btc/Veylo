// ARCHITECTURE §11.2. `pnpm verify` reports this file as its tenant-isolation check.
import { randomUUID } from "node:crypto";
import {
  claimShieldEvent,
  getApproval,
  getTreasuryEvent,
  getTreasurySessionRequest,
  updateTreasuryEvent,
  getContractor,
  getCurrentHead,
  getPayeeRequest,
  listApprovalsForContractor,
  getDestination,
  getMembership,
  listDestinations,
  updateContractor,
  getOrganization,
  listActiveMembers,
  markMemberRemoved,
  schema,
  setMemberRole,
} from "@veylo/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMember,
  createHarness,
  createOrg,
  RECIPIENT,
  signIn,
  type App,
} from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
let attacker: Awaited<ReturnType<typeof signIn>>;
let victimOwner: Awaited<ReturnType<typeof signIn>>;
let victimMember: Awaited<ReturnType<typeof addMember>>;
let orgA: string;
let orgB: string;
let contractorB: string;
let destinationB: string;
let contractorB2: string;
let destinationB2: string;
let approvalB: string;
let approvalRequestB: string;
let revokeRequestB: string;
let sessionRequestB: string;
let fundingEventB: string;
let shieldEventB: string;
let payRunB: string;
let payRunItemB: string;
const B_ADDRESS = "0xAf780910c0E7D41430D4615A437676a87a332C8C";

const TERMS = { kind: "fixed", rate: "1", schedule: "monthly" };
const NOT_FOUND = { error: { code: "NOT_FOUND", message: "Not found" } };

beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
  attacker = await signIn(app);
  orgA = (await createOrg(app, attacker.cookies, "A")).id;
  victimOwner = await signIn(app);
  orgB = (await createOrg(app, victimOwner.cookies, "B")).id;
  victimMember = await addMember(app, victimOwner.cookies, orgB, "viewer");
  const contractor = await app.inject({
    method: "POST",
    url: `/orgs/${orgB}/contractors`,
    cookies: victimOwner.cookies,
    payload: { name: "B's", terms: TERMS },
  });
  contractorB = contractor.json().id;
  // A failed check, so the recheck route would really act if the guard let an attacker through.
  h.quote.respond = () => Promise.reject(new Error("down"));
  const destination = await app.inject({
    method: "POST",
    url: `/orgs/${orgB}/contractors/${contractorB}/destinations`,
    cookies: victimOwner.cookies,
    payload: { route: "usdc-base", address: B_ADDRESS },
  });
  h.quote.respond = h.quote.accepted;
  destinationB = destination.json().id;

  // A real approved payee and live pending requests in org B, so denied routes have targets.
  const c2 = await app.inject({
    method: "POST",
    url: `/orgs/${orgB}/contractors`,
    cookies: victimOwner.cookies,
    payload: { name: "B2", terms: TERMS },
  });
  contractorB2 = c2.json().id;
  const base2 = `/orgs/${orgB}/contractors/${contractorB2}`;
  const d2 = await app.inject({
    method: "POST",
    url: `${base2}/destinations`,
    cookies: victimOwner.cookies,
    payload: { route: "usdc-base", address: B_ADDRESS },
  });
  destinationB2 = d2.json().id;
  const wallet = victimOwner.wallet;
  const start = async () =>
    (
      await app.inject({
        method: "POST",
        url: `${base2}/destinations/${destinationB2}/approval-request`,
        cookies: victimOwner.cookies,
      })
    ).json();
  const first = await start();
  const done = await app.inject({
    method: "POST",
    url: `${base2}/destinations/${destinationB2}/approval-request/${first.requestId}/complete`,
    cookies: victimOwner.cookies,
    payload: {
      accountId: wallet.accountId,
      publicKey: wallet.publicKey,
      approvalSignature: wallet.sign(first.approvalMessage, first.approvalNonce, RECIPIENT),
      headSignature: wallet.sign(first.headMessage, first.headNonce, RECIPIENT),
    },
  });
  approvalB = done.json().approvalId;
  approvalRequestB = (await start()).requestId;
  revokeRequestB = (
    await app.inject({
      method: "POST",
      url: `/orgs/${orgB}/payees/${approvalB}/revoke-request`,
      cookies: victimOwner.cookies,
    })
  ).json().requestId;

  const treasury = `/orgs/${orgB}/treasury`;
  const ownerPost = (url: string, payload?: object) =>
    app.inject({
      method: "POST",
      url,
      cookies: victimOwner.cookies,
      ...(payload ? { payload } : {}),
    });
  sessionRequestB = (await ownerPost(`${treasury}/session-request`)).json().requestId;
  fundingEventB = (
    await ownerPost(`${treasury}/funding-quote`, {
      originRoute: "usdc-base",
      amount: "1000",
      refundAddress: B_ADDRESS,
    })
  ).json().eventId;
  shieldEventB = (await ownerPost(`${treasury}/shield-request`, { amount: "1000" })).json().eventId;
  payRunB = (await ownerPost(`/orgs/${orgB}/pay-runs`, { period: "2026-11", mode: "live" })).json()
    .id;
  payRunItemB = (
    await ownerPost(`/orgs/${orgB}/pay-runs/${payRunB}/items`, {
      contractorId: contractorB2,
      amount: "1000",
    })
  ).json().id;
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

const treasurySignedAsAttacker = () => ({
  accountId: attacker.wallet.accountId,
  publicKey: attacker.wallet.publicKey,
  signature: "x",
});

const signedAsAttacker = () => ({
  accountId: attacker.wallet.accountId,
  publicKey: attacker.wallet.publicKey,
  approvalSignature: "x",
  headSignature: "x",
});

type Case = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  route: string;
  url: (orgId: string) => string;
  payload?: () => object;
};

/** Every org-scoped route. The test below fails if a new route isn't added here. */
const ORG_ROUTES: Case[] = [
  { method: "GET", route: "/orgs/:orgId", url: (o) => `/orgs/${o}` },
  { method: "GET", route: "/orgs/:orgId/members", url: (o) => `/orgs/${o}/members` },
  {
    method: "POST",
    route: "/orgs/:orgId/members",
    url: (o) => `/orgs/${o}/members`,
    payload: () => ({ nearAccountId: "intruder.near", role: "owner" }),
  },
  {
    method: "PATCH",
    route: "/orgs/:orgId/members/:userId",
    url: (o) => `/orgs/${o}/members/${victimMember.userId}`,
    payload: () => ({ role: "owner" }),
  },
  {
    method: "POST",
    route: "/orgs/:orgId/members/:userId/remove",
    url: (o) => `/orgs/${o}/members/${victimMember.userId}/remove`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/contractors",
    url: (o) => `/orgs/${o}/contractors`,
    payload: () => ({ name: "Intruder", terms: TERMS }),
  },
  { method: "GET", route: "/orgs/:orgId/contractors", url: (o) => `/orgs/${o}/contractors` },
  {
    method: "GET",
    route: "/orgs/:orgId/contractors/:contractorId",
    url: (o) => `/orgs/${o}/contractors/${contractorB}`,
  },
  {
    method: "PATCH",
    route: "/orgs/:orgId/contractors/:contractorId",
    url: (o) => `/orgs/${o}/contractors/${contractorB}`,
    payload: () => ({ name: "Hacked" }),
  },
  {
    method: "POST",
    route: "/orgs/:orgId/contractors/:contractorId/archive",
    url: (o) => `/orgs/${o}/contractors/${contractorB}/archive`,
  },
  {
    method: "GET",
    route: "/orgs/:orgId/contractors/:contractorId/destinations",
    url: (o) => `/orgs/${o}/contractors/${contractorB}/destinations`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/contractors/:contractorId/destinations",
    url: (o) => `/orgs/${o}/contractors/${contractorB}/destinations`,
    payload: () => ({ route: "usdc-base", address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }),
  },
  {
    method: "POST",
    route: "/orgs/:orgId/contractors/:contractorId/destinations/:destinationId/recheck",
    url: (o) => `/orgs/${o}/contractors/${contractorB}/destinations/${destinationB}/recheck`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/contractors/:contractorId/destinations/:destinationId/approval-request",
    url: (o) =>
      `/orgs/${o}/contractors/${contractorB2}/destinations/${destinationB2}/approval-request`,
  },
  {
    method: "POST",
    route:
      "/orgs/:orgId/contractors/:contractorId/destinations/:destinationId/approval-request/:requestId/complete",
    url: (o) =>
      `/orgs/${o}/contractors/${contractorB2}/destinations/${destinationB2}/approval-request/${approvalRequestB}/complete`,
    payload: () => signedAsAttacker(),
  },
  {
    method: "POST",
    route: "/orgs/:orgId/payees/:approvalId/revoke-request",
    url: (o) => `/orgs/${o}/payees/${approvalB}/revoke-request`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/payees/:approvalId/revoke-request/:requestId/complete",
    url: (o) => `/orgs/${o}/payees/${approvalB}/revoke-request/${revokeRequestB}/complete`,
    payload: () => signedAsAttacker(),
  },
  { method: "GET", route: "/orgs/:orgId/payee-registry", url: (o) => `/orgs/${o}/payee-registry` },
  {
    method: "POST",
    route: "/orgs/:orgId/treasury/session-request",
    url: (o) => `/orgs/${o}/treasury/session-request`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/treasury/session-request/:id/complete",
    url: (o) => `/orgs/${o}/treasury/session-request/${sessionRequestB}/complete`,
    payload: () => treasurySignedAsAttacker(),
  },
  {
    method: "POST",
    route: "/orgs/:orgId/pay-runs",
    url: (o) => `/orgs/${o}/pay-runs`,
    payload: () => ({ period: "2026-12", mode: "live" }),
  },
  { method: "GET", route: "/orgs/:orgId/pay-runs", url: (o) => `/orgs/${o}/pay-runs` },
  {
    method: "GET",
    route: "/orgs/:orgId/pay-runs/:payRunId",
    url: (o) => `/orgs/${o}/pay-runs/${payRunB}`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/pay-runs/:payRunId/items",
    url: (o) => `/orgs/${o}/pay-runs/${payRunB}/items`,
    payload: () => ({ contractorId: contractorB, amount: "1" }),
  },
  {
    method: "PATCH",
    route: "/orgs/:orgId/pay-runs/:payRunId/items/:itemId",
    url: (o) => `/orgs/${o}/pay-runs/${payRunB}/items/${payRunItemB}`,
    payload: () => ({ amount: "999" }),
  },
  {
    method: "DELETE",
    route: "/orgs/:orgId/pay-runs/:payRunId/items/:itemId",
    url: (o) => `/orgs/${o}/pay-runs/${payRunB}/items/${payRunItemB}`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/pay-runs/:payRunId/prepare",
    url: (o) => `/orgs/${o}/pay-runs/${payRunB}/prepare`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/pay-runs/:payRunId/review",
    url: (o) => `/orgs/${o}/pay-runs/${payRunB}/review`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/pay-runs/:payRunId/approve",
    url: (o) => `/orgs/${o}/pay-runs/${payRunB}/approve`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/pay-runs/:payRunId/quote",
    url: (o) => `/orgs/${o}/pay-runs/${payRunB}/quote`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request",
    url: (o) => `/orgs/${o}/pay-runs/${payRunB}/items/${payRunItemB}/sign-request`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request/:requestId/complete",
    url: (o) =>
      `/orgs/${o}/pay-runs/${payRunB}/items/${payRunItemB}/sign-request/00000000-0000-4000-8000-000000000000/complete`,
    payload: () => treasurySignedAsAttacker(),
  },
  {
    method: "POST",
    route: "/orgs/:orgId/pay-runs/:payRunId/items/:itemId/retry",
    url: (o) => `/orgs/${o}/pay-runs/${payRunB}/items/${payRunItemB}/retry`,
  },
  { method: "GET", route: "/orgs/:orgId/ledger", url: (o) => `/orgs/${o}/ledger` },
  {
    method: "GET",
    route: "/orgs/:orgId/pay-runs/:payRunId/items/:itemId/payslip",
    url: (o) => `/orgs/${o}/pay-runs/${payRunB}/items/${payRunItemB}/payslip`,
  },
  {
    method: "GET",
    route: "/orgs/:orgId/exports/payouts.csv",
    url: (o) => `/orgs/${o}/exports/payouts.csv?from=2026-01-01&to=2026-12-31`,
  },
  { method: "GET", route: "/orgs/:orgId/audit", url: (o) => `/orgs/${o}/audit` },
  {
    method: "GET",
    route: "/orgs/:orgId/treasury/balances",
    url: (o) => `/orgs/${o}/treasury/balances`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/treasury/funding-quote",
    url: (o) => `/orgs/${o}/treasury/funding-quote`,
    payload: () => ({ originRoute: "usdc-base", amount: "1", refundAddress: B_ADDRESS }),
  },
  {
    method: "POST",
    route: "/orgs/:orgId/treasury/events/:id/refresh",
    url: (o) => `/orgs/${o}/treasury/events/${fundingEventB}/refresh`,
  },
  {
    method: "POST",
    route: "/orgs/:orgId/treasury/shield-request",
    url: (o) => `/orgs/${o}/treasury/shield-request`,
    payload: () => ({ amount: "1" }),
  },
  {
    method: "POST",
    route: "/orgs/:orgId/treasury/shield-request/:id/complete",
    url: (o) => `/orgs/${o}/treasury/shield-request/${shieldEventB}/complete`,
    payload: () => treasurySignedAsAttacker(),
  },
];

const hit = (c: Case, orgId: string, cookies?: Record<string, string>) =>
  app.inject({
    method: c.method,
    url: c.url(orgId),
    ...(cookies ? { cookies } : {}),
    ...(c.payload ? { payload: c.payload() } : {}),
  });

async function stateOfB() {
  const byJson = (rows: object[]) =>
    rows
      .map((r) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
      .sort();
  return JSON.stringify([
    byJson(await h.db.select().from(schema.memberships).where(eq(schema.memberships.orgId, orgB))),
    byJson(await h.db.select().from(schema.contractors).where(eq(schema.contractors.orgId, orgB))),
    byJson(await h.db.select().from(schema.payRuns).where(eq(schema.payRuns.orgId, orgB))),
    byJson(
      await h.db.select().from(schema.signRequests).where(eq(schema.signRequests.orgId, orgB)),
    ),
    byJson(
      await h.db.select().from(schema.encumbrances).where(eq(schema.encumbrances.orgId, orgB)),
    ),
    byJson(await h.db.select().from(schema.payRunItems).where(eq(schema.payRunItems.orgId, orgB))),
    byJson(
      await h.db.select().from(schema.payoutAttempts).where(eq(schema.payoutAttempts.orgId, orgB)),
    ),
    byJson(
      await h.db.select().from(schema.treasuryEvents).where(eq(schema.treasuryEvents.orgId, orgB)),
    ),
    byJson(
      await h.db
        .select()
        .from(schema.treasurySessionRequests)
        .where(eq(schema.treasurySessionRequests.orgId, orgB)),
    ),
    byJson(
      await h.db.select().from(schema.sessions1Click).where(eq(schema.sessions1Click.orgId, orgB)),
    ),
    byJson(
      await h.db.select().from(schema.payeeApprovals).where(eq(schema.payeeApprovals.orgId, orgB)),
    ),
    byJson(
      await h.db
        .select()
        .from(schema.payeeRegistryHeads)
        .where(eq(schema.payeeRegistryHeads.orgId, orgB)),
    ),
    byJson(
      await h.db.select().from(schema.payeeRequests).where(eq(schema.payeeRequests.orgId, orgB)),
    ),
    byJson(
      await h.db
        .select()
        .from(schema.payoutDestinations)
        .where(eq(schema.payoutDestinations.orgId, orgB)),
    ),
  ]);
}

describe("the route table is complete", () => {
  it("lists every registered route with an org ID", () => {
    const list = (app as unknown as { routeList: { method: string; url: string }[] }).routeList;
    const registered = list
      .filter((r) => r.url.includes(":orgId"))
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(registered).toEqual(ORG_ROUTES.map((c) => `${c.method} ${c.route}`).sort());
  });
});

describe.each(ORG_ROUTES)("$method $route", (c) => {
  it("a member of org A gets 404 on org B, and B is unchanged", async () => {
    const before = await stateOfB();
    const res = await hit(c, orgB, attacker.cookies);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
    expect(await stateOfB()).toBe(before);
  });

  it("the response is identical to an org that doesn't exist", async () => {
    const real = await hit(c, orgB, attacker.cookies);
    const missing = await hit(c, randomUUID(), attacker.cookies);
    expect(real.statusCode).toBe(missing.statusCode);
    expect(real.body).toBe(missing.body);
  });

  it("no session gets 401, and B is unchanged", async () => {
    const before = await stateOfB();
    const res = await hit(c, orgB);
    expect(res.statusCode).toBe(401);
    expect(await stateOfB()).toBe(before);
  });

  it("a removed member gets 404", async () => {
    const ex = await addMember(app, victimOwner.cookies, orgB, "owner");
    await markMemberRemoved(h.db, orgB, ex.userId, h.clock.now);
    const before = await stateOfB();
    const res = await hit(c, orgB, ex.cookies);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
    expect(await stateOfB()).toBe(before);
  });
});

describe("an owner's rights in org A don't reach org B's members", () => {
  it("PATCH through org A on a member of org B gets 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/orgs/${orgA}/members/${victimMember.userId}`,
      cookies: attacker.cookies,
      payload: { role: "owner" },
    });
    expect(res.statusCode).toBe(404);
    const row = await getMembership(h.db, orgB, victimMember.userId);
    expect(row?.role).toBe("viewer");
  });

  it("remove through org A on a member of org B gets 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${orgA}/members/${victimMember.userId}/remove`,
      cookies: attacker.cookies,
    });
    expect(res.statusCode).toBe(404);
    const row = await getMembership(h.db, orgB, victimMember.userId);
    expect(row?.status).toBe("active");
  });

  it("/me lists only the caller's organizations", async () => {
    const res = await app.inject({ method: "GET", url: "/me", cookies: attacker.cookies });
    const orgs = (res.json().memberships as { orgId: string }[]).map((m) => m.orgId);
    expect(orgs).toEqual([orgA]);
  });
});

describe("org A's path can't reach org B's contractors or destinations", () => {
  const viaA = (suffix: string) => `/orgs/${orgA}/contractors/${contractorB}${suffix}`;

  it.each([
    ["GET", ""],
    ["PATCH", ""],
    ["POST", "/archive"],
    ["GET", "/destinations"],
    ["POST", "/destinations"],
  ] as const)("%s through org A gets 404", async (method, suffix) => {
    const before = await stateOfB();
    const res = await app.inject({
      method,
      url: viaA(suffix),
      cookies: attacker.cookies,
      ...(method === "PATCH" ? { payload: { name: "Hacked" } } : {}),
      ...(suffix === "/destinations" && method === "POST"
        ? { payload: { route: "usdc-base", address: B_ADDRESS } }
        : {}),
    });
    expect(res.statusCode).toBe(404);
    expect(await stateOfB()).toBe(before);
  });

  it("recheck through org A's own contractor can't reach org B's destination", async () => {
    const mine = await app.inject({
      method: "POST",
      url: `/orgs/${orgA}/contractors`,
      cookies: attacker.cookies,
      payload: { name: "Mine", terms: TERMS },
    });
    const before = await stateOfB();
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${orgA}/contractors/${mine.json().id}/destinations/${destinationB}/recheck`,
      cookies: attacker.cookies,
    });
    expect(res.statusCode).toBe(404);
    expect(await stateOfB()).toBe(before);
  });

  it("no denied request sends a quote", async () => {
    h.quote.requests.length = 0;
    for (const c of ORG_ROUTES) await hit(c, orgB, attacker.cookies);
    expect(h.quote.requests).toEqual([]);
  });

  it("repositories don't cross orgs", async () => {
    expect(await getContractor(h.db, orgA, contractorB)).toBeUndefined();
    expect(await getDestination(h.db, orgA, contractorB, destinationB)).toBeUndefined();
    expect(await listDestinations(h.db, orgA, contractorB)).toEqual([]);
    expect(await updateContractor(h.db, orgA, contractorB, { name: "Hacked" })).toBeUndefined();
  });
});

describe("org A's path can't reach org B's treasury", () => {
  const viaA = (suffix: string) => `/orgs/${orgA}/treasury${suffix}`;

  it.each([
    ["session request", () => `/session-request/${sessionRequestB}/complete`, true],
    ["shield request", () => `/shield-request/${shieldEventB}/complete`, true],
    ["event refresh", () => `/events/${fundingEventB}/refresh`, false],
  ] as const)("%s through org A gets 404", async (_name, suffix, signed) => {
    const before = await stateOfB();
    const res = await app.inject({
      method: "POST",
      url: viaA(suffix()),
      cookies: attacker.cookies,
      ...(signed ? { payload: treasurySignedAsAttacker() } : {}),
    });
    expect(res.statusCode).toBe(404);
    expect(await stateOfB()).toBe(before);
  });

  it("no denied request reaches 1Click", async () => {
    h.one.requests.length = 0;
    for (const c of ORG_ROUTES) await hit(c, orgB, attacker.cookies);
    expect(h.one.requests).toEqual([]);
  });

  it("repositories don't cross orgs", async () => {
    expect(await getTreasuryEvent(h.db, orgA, fundingEventB)).toBeUndefined();
    expect(await getTreasurySessionRequest(h.db, orgA, sessionRequestB)).toBeUndefined();
    await updateTreasuryEvent(h.db, orgA, fundingEventB, { status: "HACKED" });
    expect((await getTreasuryEvent(h.db, orgB, fundingEventB))?.status).not.toBe("HACKED");
    expect(await claimShieldEvent(h.db, orgA, shieldEventB)).toBe(false);
  });
});

describe("org A's path can't reach org B's payees", () => {
  it("revoke and registry repositories don't cross orgs", async () => {
    expect(await getApproval(h.db, orgA, approvalB)).toBeUndefined();
    expect(await getPayeeRequest(h.db, orgA, revokeRequestB)).toBeUndefined();
    expect(await getCurrentHead(h.db, orgA)).toBeUndefined();
    expect(await listApprovalsForContractor(h.db, orgA, contractorB2)).toEqual([]);
  });

  it("revoke through org A gets 404, with org B unchanged", async () => {
    const before = await stateOfB();
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${orgA}/payees/${approvalB}/revoke-request`,
      cookies: attacker.cookies,
    });
    expect(res.statusCode).toBe(404);
    expect(await stateOfB()).toBe(before);
  });

  it("completing org B's request through org A gets 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${orgA}/payees/${approvalB}/revoke-request/${revokeRequestB}/complete`,
      cookies: attacker.cookies,
      payload: signedAsAttacker(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("the repository layer scopes by orgId", () => {
  it("reads don't cross orgs", async () => {
    expect(await getMembership(h.db, orgA, victimMember.userId)).toBeUndefined();
    const members = await listActiveMembers(h.db, orgA);
    expect(members.map((m) => m.userId)).not.toContain(victimMember.userId);
    expect((await getOrganization(h.db, orgB))?.name).toBe("B");
  });

  it("writes don't cross orgs", async () => {
    await setMemberRole(h.db, orgA, victimMember.userId, "owner");
    await markMemberRemoved(h.db, orgA, victimMember.userId, h.clock.now);
    const row = await getMembership(h.db, orgB, victimMember.userId);
    expect(row).toMatchObject({ role: "viewer", status: "active" });
  });
});
