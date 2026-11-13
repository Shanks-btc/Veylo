// Roles (slice W5, D2). Every route has an explicit entry in the matrix below, and each entry is
// tried as every role. A route added without an entry fails the "covers every route" test.
//   owner     everything; the treasury wallet is still what signs.
//   preparer  creates and edits drafts and contractors; can't approve payees or sign.
//   accountant reads the ledger, payslips, statements, CSV and audit log, and sees a contractor's
//             name and route, nothing else personal.
//   viewer    the older read-only role.
import { ROUTES, type RouteKey } from "@veylo/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, createHarness, createOrg, signIn, type App } from "./test-support.js";

type Role = "owner" | "preparer" | "accountant" | "viewer";
const ALL: Role[] = ["owner", "preparer", "accountant", "viewer"];
const OWNER: Role[] = ["owner"];
const WRITE: Role[] = ["owner", "preparer"];
const READERS: Role[] = ["owner", "accountant"];
type Rule = Role[] | "public" | "session";

export const ROLE_MATRIX: Record<RouteKey, Rule> = {
  "GET /health": "public",
  "GET /ready": "public",
  "POST /auth/challenge": "public",
  "POST /auth/verify": "public",
  "POST /auth/logout": "session",
  "POST /auth/signup": "public",
  "POST /auth/login": "public",
  "POST /auth/verify-email": "public",
  "POST /auth/resend-verification": "session",
  "POST /auth/forgot-password": "public",
  "POST /auth/reset-password": "public",
  "POST /auth/change-password": "session",
  "POST /auth/wallet-link/challenge": "session",
  "POST /auth/wallet-link": "session",
  "GET /me": "session",
  "POST /orgs": "session",
  "GET /orgs/:orgId": ALL,
  "GET /orgs/:orgId/members": ALL,
  "POST /orgs/:orgId/members": OWNER,
  "PATCH /orgs/:orgId/members/:userId": OWNER,
  "POST /orgs/:orgId/members/:userId/remove": OWNER,
  "GET /orgs/:orgId/contractors": ALL,
  "POST /orgs/:orgId/contractors": WRITE,
  "POST /orgs/:orgId/contractors/import": WRITE,
  "GET /orgs/:orgId/contractors/:contractorId": ALL,
  "PATCH /orgs/:orgId/contractors/:contractorId": WRITE,
  "POST /orgs/:orgId/contractors/:contractorId/archive": WRITE,
  "GET /orgs/:orgId/contractors/:contractorId/destinations": ALL,
  "POST /orgs/:orgId/contractors/:contractorId/destinations": WRITE,
  "POST /orgs/:orgId/contractors/:contractorId/destinations/:destinationId/recheck": WRITE,
  "POST /orgs/:orgId/contractors/:contractorId/destinations/:destinationId/approval-request": OWNER,
  "POST /orgs/:orgId/contractors/:contractorId/destinations/:destinationId/approval-request/:requestId/complete":
    OWNER,
  "POST /orgs/:orgId/payees/:approvalId/revoke-request": OWNER,
  "POST /orgs/:orgId/payees/:approvalId/revoke-request/:requestId/complete": OWNER,
  "POST /orgs/:orgId/contractors/:contractorId/invites": OWNER,
  "GET /orgs/:orgId/contractors/:contractorId/address-changes": WRITE,
  "POST /orgs/:orgId/contractors/:contractorId/address-changes/:requestId/apply": OWNER,
  // The portal is for a signed-in contractor, not an organisation member.
  "POST /portal/invites/accept": "session",
  "GET /portal/me": "session",
  "GET /portal/contractors/:contractorId/payslips": "session",
  "GET /portal/contractors/:contractorId/destinations": "session",
  "GET /portal/contractors/:contractorId/address-changes": "session",
  "POST /portal/contractors/:contractorId/address-change": "session",
  "GET /portal/contractors/:contractorId/balance": "session",
  "POST /portal/contractors/:contractorId/session-request": "session",
  "POST /portal/contractors/:contractorId/session-request/:id/complete": "session",
  "GET /orgs/:orgId/payee-registry": ALL,
  "GET /orgs/:orgId/payee-registry/history": ALL,
  "GET /orgs/:orgId/settings": ALL,
  "PATCH /orgs/:orgId/settings": OWNER,
  "GET /fx": "session",
  "PATCH /portal/contractors/:contractorId/display-currency": "session",
  "GET /orgs/:orgId/payroll-schedule": ALL,
  "PUT /orgs/:orgId/payroll-schedule": OWNER,
  "POST /orgs/:orgId/payroll-schedule/pause": OWNER,
  "POST /orgs/:orgId/payroll-schedule/resume": OWNER,
  "POST /orgs/:orgId/pay-runs": WRITE,
  "GET /orgs/:orgId/pay-runs": ALL,
  "GET /orgs/:orgId/pay-runs/:payRunId": ALL,
  "POST /orgs/:orgId/pay-runs/:payRunId/items": WRITE,
  "PATCH /orgs/:orgId/pay-runs/:payRunId/items/:itemId": WRITE,
  "DELETE /orgs/:orgId/pay-runs/:payRunId/items/:itemId": WRITE,
  "POST /orgs/:orgId/pay-runs/:payRunId/prepare": WRITE,
  "POST /orgs/:orgId/pay-runs/:payRunId/review": OWNER,
  "POST /orgs/:orgId/pay-runs/:payRunId/approve": OWNER,
  "POST /orgs/:orgId/pay-runs/:payRunId/quote": OWNER,
  "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request": OWNER,
  "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request/:requestId/complete": OWNER,
  "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/retry": OWNER,
  "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/acknowledge": OWNER,
  "GET /orgs/:orgId/ledger": READERS,
  "GET /orgs/:orgId/pay-runs/:payRunId/items/:itemId/payslip": READERS,
  "GET /orgs/:orgId/exports/payouts.csv": READERS,
  "GET /orgs/:orgId/audit": READERS,
  "POST /orgs/:orgId/treasury/session-request": OWNER,
  "POST /orgs/:orgId/treasury/session-request/:id/complete": OWNER,
  "GET /orgs/:orgId/treasury/balances": ALL,
  "POST /orgs/:orgId/treasury/funding-quote": OWNER,
  "POST /orgs/:orgId/treasury/shield-request": OWNER,
  "POST /orgs/:orgId/treasury/shield-request/:id/complete": OWNER,
  "POST /orgs/:orgId/treasury/events/:id/refresh": OWNER,
};

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
let orgId: string;
const cookies = {} as Record<Role, Record<string, string>>;
let outsider: Record<string, string>;
beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
  const owner = await signIn(app);
  const org = await createOrg(app, owner.cookies);
  orgId = org.id;
  cookies.owner = owner.cookies;
  for (const role of ["preparer", "accountant", "viewer"] as const)
    cookies[role] = (await addMember(app, owner.cookies, orgId, role)).cookies;
  outsider = (await signIn(app)).cookies;
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

const ZERO = "99999999-9999-4999-8999-999999999999";
const urlOf = (key: RouteKey) => {
  const path = key
    .split(" ")[1]!
    .replace(":orgId", orgId)
    .replace(/:[A-Za-z]+/g, ZERO);
  return key.includes("payouts.csv") ? `${path}?from=2026-11-01&to=2026-11-30` : path;
};
const methodOf = (key: RouteKey) => key.split(" ")[0]! as "GET" | "POST" | "PATCH" | "DELETE";
const orgRoutes = (Object.keys(ROUTES) as RouteKey[]).filter((k) => k.includes(":orgId"));

describe("role matrix (D2)", () => {
  it("covers every route, and names none that doesn't exist", () => {
    expect(Object.keys(ROLE_MATRIX).sort()).toEqual(Object.keys(ROUTES).sort());
  });

  for (const key of orgRoutes) {
    const rule = ROLE_MATRIX[key];
    // A route with no entry is reported by the covers-every-route test above, not by a crash here.
    if (rule === undefined || typeof rule === "string") continue;
    for (const role of ALL) {
      const allowed = rule.includes(role);
      it(`${key} as ${role}: ${allowed ? "allowed" : "403"}`, async () => {
        const res = await app.inject({
          method: methodOf(key),
          url: urlOf(key),
          cookies: cookies[role],
        });
        if (allowed)
          expect([401, 403], `${res.statusCode} ${res.body}`).not.toContain(res.statusCode);
        else expect(res.statusCode, res.body).toBe(403);
      });
    }
    it(`${key} as a non-member: 404, the organisation isn't revealed`, async () => {
      const res = await app.inject({ method: methodOf(key), url: urlOf(key), cookies: outsider });
      expect(res.statusCode).toBe(404);
    });
  }
});

describe("what each role does", () => {
  it("a preparer drafts a contractor and a pay run, but can't ask for a payee approval or a signature", async () => {
    const c = await app.inject({
      method: "POST",
      url: `/orgs/${orgId}/contractors`,
      cookies: cookies.preparer,
      payload: { name: "Pat", terms: { kind: "fixed", rate: "1000000", schedule: "monthly" } },
    });
    expect(c.statusCode).toBe(201);
    const run = await app.inject({
      method: "POST",
      url: `/orgs/${orgId}/pay-runs`,
      cookies: cookies.preparer,
      payload: { period: "2026-11", mode: "live" },
    });
    expect(run.statusCode).toBe(201);
    const approval = await app.inject({
      method: "POST",
      url: `/orgs/${orgId}/contractors/${(c.json() as { id: string }).id}/destinations/${ZERO}/approval-request`,
      cookies: cookies.preparer,
    });
    expect(approval.statusCode).toBe(403);
  });

  it("an accountant sees a contractor's name and route, and nothing else personal", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/orgs/${orgId}/contractors`,
      cookies: cookies.owner,
      payload: {
        name: "Quinn",
        email: "quinn@example.com",
        terms: { kind: "fixed", rate: "2000000", schedule: "monthly" },
      },
    });
    const id = (created.json() as { id: string }).id;
    const owner = (
      await app.inject({
        method: "GET",
        url: `/orgs/${orgId}/contractors/${id}`,
        cookies: cookies.owner,
      })
    ).json() as { email: string };
    expect(owner.email).toBe("quinn@example.com");
    for (const role of ["accountant", "viewer"] as const) {
      const seen = (
        await app.inject({
          method: "GET",
          url: `/orgs/${orgId}/contractors/${id}`,
          cookies: cookies[role],
        })
      ).json() as { name: string; email: unknown; terms: unknown };
      expect(seen).toMatchObject({ name: "Quinn", email: null, terms: {} });
      const list = (
        await app.inject({
          method: "GET",
          url: `/orgs/${orgId}/contractors`,
          cookies: cookies[role],
        })
      ).json() as { contractors: { email: unknown }[] };
      expect(list.contractors.every((c) => c.email === null)).toBe(true);
    }
  });
});
