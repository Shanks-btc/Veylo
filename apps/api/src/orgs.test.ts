import { schema } from "@veylo/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, createHarness, createOrg, signIn, type App } from "./test-support.js";

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

const setRole = (orgId: string, userId: string, role: string, cookies: Record<string, string>) =>
  app.inject({
    method: "PATCH",
    url: `/orgs/${orgId}/members/${userId}`,
    cookies,
    payload: { role },
  });
const remove = (orgId: string, userId: string, cookies: Record<string, string>) =>
  app.inject({ method: "POST", url: `/orgs/${orgId}/members/${userId}/remove`, cookies });
const addByAccount = (
  orgId: string,
  nearAccountId: string,
  role: string,
  cookies: Record<string, string>,
) =>
  app.inject({
    method: "POST",
    url: `/orgs/${orgId}/members`,
    cookies,
    payload: { nearAccountId, role },
  });

async function ownerAndOrg() {
  const owner = await signIn(app);
  const org = await createOrg(app, owner.cookies);
  const me = await app.inject({ method: "GET", url: "/me", cookies: owner.cookies });
  return { ...owner, org, userId: me.json().user.id as string };
}

describe("POST /orgs", () => {
  it("creates the org, the treasury on the caller's account, and an owner membership", async () => {
    const { wallet, org, cookies } = await ownerAndOrg();
    expect(org.treasuryAccountId).toBe(wallet.accountId);
    const get = await app.inject({ method: "GET", url: `/orgs/${org.id}`, cookies });
    expect(get.json()).toEqual({
      id: org.id,
      name: "Org",
      treasuryAccountId: wallet.accountId,
    });
    const members = await app.inject({ method: "GET", url: `/orgs/${org.id}/members`, cookies });
    expect(members.json().members).toMatchObject([
      { nearAccountId: wallet.accountId, role: "owner" },
    ]);
  });

  it("appears on /me", async () => {
    const { org, cookies } = await ownerAndOrg();
    const me = await app.inject({ method: "GET", url: "/me", cookies });
    expect(me.json().memberships).toEqual([{ orgId: org.id, orgName: "Org", role: "owner" }]);
  });

  it.each([{}, { name: "" }, { name: "   " }, { name: "x".repeat(201) }, { name: "a", id: "b" }])(
    "rejects %j",
    async (payload) => {
      const { cookies } = await signIn(app);
      const res = await app.inject({ method: "POST", url: "/orgs", cookies, payload });
      expect(res.statusCode).toBe(400);
    },
  );

  it("requires a session", async () => {
    const res = await app.inject({ method: "POST", url: "/orgs", payload: { name: "x" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("roles", () => {
  it.each(["viewer", "accountant"] as const)("a %s can read", async (role) => {
    const { org, cookies } = await ownerAndOrg();
    const member = await addMember(app, cookies, org.id, role);
    for (const url of [`/orgs/${org.id}`, `/orgs/${org.id}/members`]) {
      const res = await app.inject({ method: "GET", url, cookies: member.cookies });
      expect(res.statusCode).toBe(200);
    }
  });

  it.each(["viewer", "accountant"] as const)("a %s gets 403 on owner routes", async (role) => {
    const { org, cookies, userId } = await ownerAndOrg();
    const member = await addMember(app, cookies, org.id, role);
    const responses = await Promise.all([
      addByAccount(org.id, "someone.near", "viewer", member.cookies),
      setRole(org.id, userId, "viewer", member.cookies),
      remove(org.id, userId, member.cookies),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([403, 403, 403]);
  });

  it("an owner can change a role", async () => {
    const { org, cookies } = await ownerAndOrg();
    const member = await addMember(app, cookies, org.id, "viewer");
    const res = await setRole(org.id, member.userId, "accountant", cookies);
    expect(res.json()).toEqual({ userId: member.userId, role: "accountant" });
  });

  it("rejects an unknown role and a malformed ID", async () => {
    const { org, cookies, userId } = await ownerAndOrg();
    expect((await setRole(org.id, userId, "admin", cookies)).statusCode).toBe(400);
    const res = await app.inject({ method: "GET", url: "/orgs/not-a-uuid", cookies });
    expect(res.statusCode).toBe(400);
  });
});

describe("adding members", () => {
  it("can add an account that has never signed in", async () => {
    const { org, cookies } = await ownerAndOrg();
    const res = await addByAccount(org.id, `new-${org.id.slice(0, 8)}.near`, "viewer", cookies);
    expect(res.statusCode).toBe(201);
  });

  it("refuses an existing active member", async () => {
    const { org, cookies, wallet } = await ownerAndOrg();
    const res = await addByAccount(org.id, wallet.accountId, "viewer", cookies);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("ALREADY_MEMBER");
  });
});

describe("removal (L22)", () => {
  it("keeps the row, and the member loses access", async () => {
    const { org, cookies } = await ownerAndOrg();
    const member = await addMember(app, cookies, org.id, "viewer");
    expect((await remove(org.id, member.userId, cookies)).statusCode).toBe(200);

    const [row] = await h.db
      .select()
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.orgId, org.id), eq(schema.memberships.userId, member.userId)),
      );
    expect(row?.status).toBe("removed");
    expect(row?.removedAt).toEqual(h.clock.now);

    const read = await app.inject({
      method: "GET",
      url: `/orgs/${org.id}`,
      cookies: member.cookies,
    });
    expect(read.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: `/orgs/${org.id}/members`, cookies });
    expect(list.json().members.map((m: { userId: string }) => m.userId)).not.toContain(
      member.userId,
    );
    const me = await app.inject({ method: "GET", url: "/me", cookies: member.cookies });
    expect(me.json().memberships).toEqual([]);
  });

  it("removing or changing someone already removed gets 404", async () => {
    const { org, cookies } = await ownerAndOrg();
    const member = await addMember(app, cookies, org.id, "viewer");
    await remove(org.id, member.userId, cookies);
    expect((await remove(org.id, member.userId, cookies)).statusCode).toBe(404);
    expect((await setRole(org.id, member.userId, "owner", cookies)).statusCode).toBe(404);
  });

  it("re-adding reactivates the same row with the new role", async () => {
    const { org, cookies } = await ownerAndOrg();
    const member = await addMember(app, cookies, org.id, "viewer");
    await remove(org.id, member.userId, cookies);
    const res = await addByAccount(org.id, member.wallet.accountId, "accountant", cookies);
    expect(res.statusCode).toBe(201);
    const rows = await h.db
      .select()
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.orgId, org.id), eq(schema.memberships.userId, member.userId)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "active", role: "accountant", removedAt: null });
    const read = await app.inject({
      method: "GET",
      url: `/orgs/${org.id}`,
      cookies: member.cookies,
    });
    expect(read.statusCode).toBe(200);
  });

  it("the database refuses DELETE on memberships", async () => {
    const { org } = await ownerAndOrg();
    await expect(
      h.db.delete(schema.memberships).where(eq(schema.memberships.orgId, org.id)),
    ).rejects.toThrow();
    await expect(h.db.execute(sql`TRUNCATE memberships CASCADE`)).rejects.toThrow();
  });

  it("the database keeps status and removed_at consistent", async () => {
    const { org, userId } = await ownerAndOrg();
    await expect(
      h.db
        .update(schema.memberships)
        .set({ status: "removed" })
        .where(and(eq(schema.memberships.orgId, org.id), eq(schema.memberships.userId, userId))),
    ).rejects.toThrow();
  });
});

describe("last-owner protection", () => {
  const LAST_OWNER = { error: { code: "LAST_OWNER" } };

  it("refuses to remove the last owner", async () => {
    const { org, cookies, userId } = await ownerAndOrg();
    const res = await remove(org.id, userId, cookies);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject(LAST_OWNER);
  });

  it.each(["viewer", "accountant"])("refuses to demote the last owner to %s", async (role) => {
    const { org, cookies, userId } = await ownerAndOrg();
    const res = await setRole(org.id, userId, role, cookies);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject(LAST_OWNER);
  });

  it("allows setting the last owner to owner", async () => {
    const { org, cookies, userId } = await ownerAndOrg();
    expect((await setRole(org.id, userId, "owner", cookies)).statusCode).toBe(200);
  });

  it("allows removing a non-treasury owner, while the treasury owner remains", async () => {
    const { org, cookies } = await ownerAndOrg();
    const second = await addMember(app, cookies, org.id, "owner");
    expect((await remove(org.id, second.userId, cookies)).statusCode).toBe(200);
  });

  it("a removed owner doesn't count as an owner", async () => {
    const { org, cookies, userId } = await ownerAndOrg();
    const second = await addMember(app, cookies, org.id, "owner");
    await remove(org.id, second.userId, cookies);
    expect((await setRole(org.id, userId, "viewer", cookies)).statusCode).toBe(409);
  });

  it("two owners removing each other at once leaves one of them, plus the treasury", async () => {
    const { org, cookies } = await ownerAndOrg();
    const second = await addMember(app, cookies, org.id, "owner");
    const third = await addMember(app, cookies, org.id, "owner");
    const results = await Promise.all([
      remove(org.id, third.userId, second.cookies),
      remove(org.id, second.userId, third.cookies),
    ]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const owners = await h.db
      .select()
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.orgId, org.id),
          eq(schema.memberships.role, "owner"),
          eq(schema.memberships.status, "active"),
        ),
      );
    expect(owners).toHaveLength(2);
  });
});

describe("the treasury account's membership (L30)", () => {
  async function withSecondOwner() {
    const s = await ownerAndOrg();
    const second = await addMember(app, s.cookies, s.org.id, "owner");
    return { ...s, second };
  }

  it("can't be removed, even with another owner present", async () => {
    const { org, userId, second } = await withSecondOwner();
    const res = await remove(org.id, userId, second.cookies);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("TREASURY_MEMBER");
  });

  it.each(["viewer", "accountant"])("can't be demoted to %s", async (role) => {
    const { org, userId, second } = await withSecondOwner();
    const res = await setRole(org.id, userId, role, second.cookies);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("TREASURY_MEMBER");
  });

  it("can be set to owner, a no-op", async () => {
    const { org, userId, second } = await withSecondOwner();
    expect((await setRole(org.id, userId, "owner", second.cookies)).statusCode).toBe(200);
  });

  it("other owners can still be demoted", async () => {
    const { org, cookies, second } = await withSecondOwner();
    expect((await setRole(org.id, second.userId, "viewer", cookies)).statusCode).toBe(200);
  });
});

describe("audit log", () => {
  it("records org creation, member add, role change and removal", async () => {
    const { org, cookies } = await ownerAndOrg();
    const member = await addMember(app, cookies, org.id, "viewer");
    await setRole(org.id, member.userId, "accountant", cookies);
    await remove(org.id, member.userId, cookies);
    const rows = await h.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, org.id));
    expect(rows.map((r) => r.action).sort()).toEqual([
      "member.add",
      "member.remove",
      "member.role_change",
      "org.create",
    ]);
  });

  it("refused actions aren't recorded", async () => {
    const { org, cookies, userId } = await ownerAndOrg();
    await remove(org.id, userId, cookies);
    const rows = await h.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, org.id));
    expect(rows.map((r) => r.action)).toEqual(["org.create"]);
  });
});
