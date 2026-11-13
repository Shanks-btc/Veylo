// The contractor portal (slice W5, D3): invites, what a contractor can see, and the 24-hour
// cooling period on a changed payout address.
import { createHash } from "node:crypto";
import { schema } from "@veylo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, createHarness, createOrg, signIn, type App } from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
  for (const a of ["ada-new.near", "ada-newer.near"]) h.chain.set(a, new Map());
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

const HOUR = 3_600_000;
// Sessions last 24 hours, so a test that jumps the clock signs in again afterwards.
async function relog(w: {
  owner: { wallet: never; cookies: Record<string, string> };
  contractor: { wallet: never; cookies: Record<string, string> };
}) {
  w.owner.cookies = (await signIn(app, w.owner.wallet)).cookies;
  w.contractor.cookies = (await signIn(app, w.contractor.wallet)).cookies;
}
type Cookies = Record<string, string>;
const call = (method: "GET" | "POST", url: string, cookies: Cookies, payload?: object) =>
  app.inject({ method, url, cookies, payload });

async function world() {
  const owner = await signIn(app);
  const org = await createOrg(app, owner.cookies);
  const made = await call("POST", `/orgs/${org.id}/contractors`, owner.cookies, {
    name: "Ada Lovelace",
    terms: { kind: "fixed", rate: "5000000", schedule: "monthly" },
  });
  const contractorId = (made.json() as { id: string }).id;
  const invite = async () =>
    (
      await call("POST", `/orgs/${org.id}/contractors/${contractorId}/invites`, owner.cookies)
    ).json() as {
      token: string;
      expiresAt: string;
    };
  const contractor = await signIn(app);
  return { owner, org, contractorId, invite, contractor };
}

describe("invites", () => {
  it("shows the link's token once and keeps only its hash", async () => {
    const w = await world();
    const { token } = await w.invite();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await h.db.select().from(schema.contractorInvites);
    const mine = rows.filter((r) => r.contractorId === w.contractorId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("is single use: the same link can't be accepted twice, by anyone", async () => {
    const w = await world();
    const { token } = await w.invite();
    const first = await call("POST", "/portal/invites/accept", w.contractor.cookies, { token });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ orgId: w.org.id, contractorId: w.contractorId });
    const again = await call("POST", "/portal/invites/accept", w.contractor.cookies, { token });
    expect(again.statusCode).toBe(400);
    const stranger = await signIn(app);
    expect(
      (await call("POST", "/portal/invites/accept", stranger.cookies, { token })).statusCode,
    ).toBe(400);
  });

  it("two people racing for one link: exactly one gets it", async () => {
    const w = await world();
    const { token } = await w.invite();
    const other = await signIn(app);
    const results = await Promise.all([
      call("POST", "/portal/invites/accept", w.contractor.cookies, { token }),
      call("POST", "/portal/invites/accept", other.cookies, { token }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  });

  it("expires after 7 days", async () => {
    const w = await world();
    const { token } = await w.invite();
    h.clock.now = new Date(h.clock.now.getTime() + 7 * 24 * HOUR + 1000);
    await relog(w as never);
    const res = await call("POST", "/portal/invites/accept", w.contractor.cookies, { token });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "INVITE_INVALID" } });
    h.clock.now = new Date(h.clock.now.getTime() - 7 * 24 * HOUR - 1000);
  });

  it("refuses an unknown or malformed token the same way", async () => {
    const w = await world();
    for (const token of ["A".repeat(43), "short", "!".repeat(43)]) {
      const res = await call("POST", "/portal/invites/accept", w.contractor.cookies, { token });
      expect(res.statusCode).toBe(400);
    }
  });

  it("needs a signed-in user, and only the owner can make one", async () => {
    const w = await world();
    const { token } = await w.invite();
    expect((await call("POST", "/portal/invites/accept", {}, { token })).statusCode).toBe(401);
    const prep = await addMember(app, w.owner.cookies, w.org.id, "preparer");
    const res = await call(
      "POST",
      `/orgs/${w.org.id}/contractors/${w.contractorId}/invites`,
      prep.cookies,
    );
    expect(res.statusCode).toBe(403);
  });

  it("a second person can't take over a contractor who already joined, and the link isn't spent", async () => {
    const w = await world();
    await call("POST", "/portal/invites/accept", w.contractor.cookies, {
      token: (await w.invite()).token,
    });
    const second = await w.invite();
    const thief = await signIn(app);
    const res = await call("POST", "/portal/invites/accept", thief.cookies, {
      token: second.token,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "INVITE_CLAIMED" } });
    const spent = (await h.db.select().from(schema.contractorInvites)).find(
      (r) => r.tokenHash === createHash("sha256").update(second.token).digest("hex"),
    );
    expect(spent?.acceptedAt).toBeNull();
  });
});

describe("what a contractor can see", () => {
  it("lists their own organisation and contractor, and nothing of anyone else's", async () => {
    const w = await world();
    await call("POST", "/portal/invites/accept", w.contractor.cookies, {
      token: (await w.invite()).token,
    });
    const me = (await call("GET", "/portal/me", w.contractor.cookies)).json() as {
      contractors: { contractorId: string; name: string }[];
    };
    expect(me.contractors).toMatchObject([{ contractorId: w.contractorId, name: "Ada Lovelace" }]);
    const none = (await call("GET", "/portal/me", (await signIn(app)).cookies)).json();
    expect(none).toEqual({ contractors: [] });
  });

  it("another user, and even the organisation's owner, get 404 for a contractor that isn't theirs", async () => {
    const w = await world();
    await call("POST", "/portal/invites/accept", w.contractor.cookies, {
      token: (await w.invite()).token,
    });
    const stranger = await signIn(app);
    for (const path of ["payslips", "destinations", "address-changes", "balance"]) {
      const url = `/portal/contractors/${w.contractorId}/${path}`;
      expect((await call("GET", url, stranger.cookies)).statusCode, `stranger ${path}`).toBe(404);
      expect((await call("GET", url, w.owner.cookies)).statusCode, `owner ${path}`).toBe(404);
      expect((await call("GET", url, {})).statusCode, `no session ${path}`).toBe(401);
    }
    const post = await call(
      "POST",
      `/portal/contractors/${w.contractorId}/address-change`,
      stranger.cookies,
      { route: "usdc-near-confidential", address: "ada-new.near" },
    );
    expect(post.statusCode).toBe(404);
  });

  it("their payslips list is theirs, and their private balance says it needs a session", async () => {
    const w = await world();
    await call("POST", "/portal/invites/accept", w.contractor.cookies, {
      token: (await w.invite()).token,
    });
    expect(
      (
        await call("GET", `/portal/contractors/${w.contractorId}/payslips`, w.contractor.cookies)
      ).json(),
    ).toEqual({ payslips: [] });
    const balance = (
      await call("GET", `/portal/contractors/${w.contractorId}/balance`, w.contractor.cookies)
    ).json();
    expect(balance).toMatchObject({ available: false, unavailable: "needs_session" });
  });
});

describe("changing the payout address (24-hour cooling)", () => {
  async function joined() {
    const w = await world();
    await call("POST", "/portal/invites/accept", w.contractor.cookies, {
      token: (await w.invite()).token,
    });
    // The contractor's current address, entered by the owner (it is accepted and active).
    h.chain.set("ada-old.near", new Map());
    const dest = await call(
      "POST",
      `/orgs/${w.org.id}/contractors/${w.contractorId}/destinations`,
      w.owner.cookies,
      { route: "usdc-near-confidential", address: "ada-old.near" },
    );
    expect(dest.statusCode).toBe(201);
    const request = (address = "ada-new.near") =>
      call("POST", `/portal/contractors/${w.contractorId}/address-change`, w.contractor.cookies, {
        route: "usdc-near-confidential",
        address,
      });
    const changes = async () =>
      (
        (
          await call(
            "GET",
            `/orgs/${w.org.id}/contractors/${w.contractorId}/address-changes`,
            w.owner.cookies,
          )
        ).json() as {
          changes: { id: string; canApply: boolean; appliesAfter: string; applied: boolean }[];
        }
      ).changes;
    const apply = (id: string) =>
      call(
        "POST",
        `/orgs/${w.org.id}/contractors/${w.contractorId}/address-changes/${id}/apply`,
        w.owner.cookies,
      );
    const destinations = async () =>
      (
        (
          await call(
            "GET",
            `/orgs/${w.org.id}/contractors/${w.contractorId}/destinations`,
            w.owner.cookies,
          )
        ).json() as { destinations: { address: string; status: string }[] }
      ).destinations;
    return { ...w, request, changes, apply, destinations };
  }

  it("a request changes nothing for 24 hours: the old address and its approval stay as they were", async () => {
    const w = await joined();
    const t0 = h.clock.now;
    const res = await w.request();
    expect(res.statusCode).toBe(201);
    expect(new Date((res.json() as { appliesAfter: string }).appliesAfter).getTime()).toBe(
      t0.getTime() + 24 * HOUR,
    );
    expect(await w.destinations()).toMatchObject([{ address: "ada-old.near", status: "active" }]);
  });

  it("the owner sees the pending change with the time it can be applied, and can't apply it early", async () => {
    const w = await joined();
    const t0 = h.clock.now;
    const created = (await w.request()).json() as { id: string };
    const [pending] = await w.changes();
    expect(pending).toMatchObject({ id: created.id, canApply: false, applied: false });
    for (const early of [1, 12 * HOUR, 24 * HOUR - 60_000]) {
      h.clock.now = new Date(t0.getTime() + early);
      const res = await w.apply(created.id);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: "COOLING_PERIOD" } });
      expect((await w.changes())[0]?.canApply).toBe(false);
    }
    expect(await w.destinations()).toMatchObject([{ address: "ada-old.near", status: "active" }]);
    h.clock.now = t0;
  });

  it("at 24 hours the owner can apply it: the new address replaces the old, once", async () => {
    const w = await joined();
    const t0 = h.clock.now;
    const created = (await w.request()).json() as { id: string };
    h.clock.now = new Date(t0.getTime() + 24 * HOUR);
    await relog(w as never);
    expect((await w.changes())[0]?.canApply).toBe(true);
    const res = await w.apply(created.id);
    expect(res.statusCode).toBe(200);
    const dests = await w.destinations();
    expect(dests.find((d) => d.address === "ada-new.near")?.status).toBe("active");
    expect(dests.find((d) => d.address === "ada-old.near")?.status).toBe("superseded");
    const again = await w.apply(created.id);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: "ALREADY_APPLIED" } });
    expect((await w.destinations()).filter((d) => d.address === "ada-new.near")).toHaveLength(1);
    h.clock.now = t0;
  });

  it("the new address ages from the contractor's request, so a pay run doesn't make it wait again", async () => {
    const w = await joined();
    const t0 = h.clock.now;
    const created = (await w.request()).json() as { id: string };
    h.clock.now = new Date(t0.getTime() + 30 * HOUR);
    await relog(w as never);
    await w.apply(created.id);
    const row = (await h.db.select().from(schema.payoutDestinations)).find(
      (d) => d.address === "ada-new.near",
    );
    expect(row?.createdAt.getTime()).toBe(t0.getTime());
    h.clock.now = t0;
  });

  it("refuses a bad address, an account NEAR doesn't know, and a payout route that isn't one", async () => {
    const w = await joined();
    const bad = await w.request("Not A Valid Account!");
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: "ADDRESS_INVALID" } });
    const ghost = await w.request("ghost-wallet.near");
    expect(ghost.statusCode).toBe(400);
    expect(ghost.json()).toMatchObject({ error: { code: "ACCOUNT_NOT_FOUND" } });
    const wrongRoute = await call(
      "POST",
      `/portal/contractors/${w.contractorId}/address-change`,
      w.contractor.cookies,
      { route: "bitcoin", address: "ada-new.near" },
    );
    expect(wrongRoute.statusCode).toBe(400);
    expect(await w.changes()).toEqual([]);
  });

  it("the contractor sees their pending request and when it applies", async () => {
    const w = await joined();
    await w.request();
    const mine = (
      await call(
        "GET",
        `/portal/contractors/${w.contractorId}/address-changes`,
        w.contractor.cookies,
      )
    ).json() as { changes: { canApply: boolean; address: string }[] };
    expect(mine.changes).toMatchObject([{ address: "ada-new.near", canApply: false }]);
  });

  it("only the owner applies; a preparer can see the request but not apply it", async () => {
    const w = await joined();
    const created = (await w.request()).json() as { id: string };
    const prep = await addMember(app, w.owner.cookies, w.org.id, "preparer");
    expect(
      (
        await call(
          "GET",
          `/orgs/${w.org.id}/contractors/${w.contractorId}/address-changes`,
          prep.cookies,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          "POST",
          `/orgs/${w.org.id}/contractors/${w.contractorId}/address-changes/${created.id}/apply`,
          prep.cookies,
        )
      ).statusCode,
    ).toBe(403);
  });
});
