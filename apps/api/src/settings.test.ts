// Organisation settings, display currency and display-only FX (slice W6). Settings are display
// choices: they never reach an amount or a signature.
import { readFileSync } from "node:fs";
import { listOutboxFor } from "@veylo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFxClient, FX_URL, parseFxBody, rateLiteral } from "./fx.js";
import { addMember, createHarness, createOrg, signIn, type App } from "./test-support.js";

const FIXTURE = readFileSync(
  new URL("./fixtures/fx-er-api-2026-11-12.json", import.meta.url),
  "utf8",
);
const NOW = new Date("2026-11-12T12:00:00.000Z");

describe("the FX client (display only)", () => {
  const response = (body: string, ok = true) =>
    ({ ok, status: ok ? 200 : 500, text: async () => body }) as Response;

  it("reads each rate as the exact text the provider wrote, never through a float", () => {
    const r = parseFxBody(FIXTURE, NOW);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.rates.NGN).toBe("1349.822603");
    expect(r.rates.KES).toBe("129.969067");
    expect(r.rates.USD).toBe("1");
    expect(r.base).toBe("USD");
    expect(r.source.attribution).toBe("Rates by Exchange Rate API");
    expect(r.providerUpdatedAt).toBe("2026-11-12T00:02:31.000Z");
    expect(rateLiteral('{"EUR":0.899865,"X":1}', "EUR")).toBe("0.899865");
  });

  it("is unavailable when the answer is not a success, not USD-based or too thin", () => {
    expect(parseFxBody('{"result":"error"}', NOW)).toEqual({ available: false });
    expect(parseFxBody(FIXTURE.replace(/"base_code":\s*"USD"/, '"base_code":"EUR"'), NOW)).toEqual({
      available: false,
    });
    expect(parseFxBody('{"result":"success","base_code":"USD","rates":{"USD":1}}', NOW)).toEqual({
      available: false,
    });
    expect(parseFxBody("not json", NOW)).toEqual({ available: false });
  });

  it("caches for at most an hour, then fetches again", async () => {
    let calls = 0;
    let now = NOW;
    const client = createFxClient({
      fetch: (async (url: string) => {
        expect(url).toBe(FX_URL);
        calls += 1;
        return response(FIXTURE);
      }) as unknown as typeof fetch,
      clock: () => now,
    });
    await client.rates();
    now = new Date(NOW.getTime() + 59 * 60_000);
    await client.rates();
    expect(calls).toBe(1);
    now = new Date(NOW.getTime() + 61 * 60_000);
    await client.rates();
    expect(calls).toBe(2);
  });

  it("says unavailable on a failure, and never serves a rate older than the hour", async () => {
    let fail = false;
    let now = NOW;
    const client = createFxClient({
      fetch: (async () =>
        fail ? response("", false) : response(FIXTURE)) as unknown as typeof fetch,
      clock: () => now,
    });
    expect((await client.rates()).available).toBe(true);
    fail = true;
    now = new Date(NOW.getTime() + 2 * 3600_000);
    expect(await client.rates()).toEqual({ available: false });
    const throwing = createFxClient({
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      clock: () => NOW,
    });
    expect(await throwing.rates()).toEqual({ available: false });
  });
});

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
let owner: Awaited<ReturnType<typeof signIn>>;
let orgId: string;
beforeAll(async () => {
  h = await createHarness();
  const fx = createFxClient({
    fetch: (async () => ({
      ok: true,
      status: 200,
      text: async () => FIXTURE,
    })) as unknown as typeof fetch,
    clock: () => NOW,
  });
  app = await h.build({ fx });
  owner = await signIn(app);
  orgId = (await createOrg(app, owner.cookies, "Northwind")).id;
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

const patch = (url: string, payload: object, cookies = owner.cookies) =>
  app.inject({ method: "PATCH", url, payload, cookies });

describe("organisation settings", () => {
  it("starts in USD and UTC with sensible notices", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/orgs/${orgId}/settings`,
      cookies: owner.cookies,
    });
    expect(res.json()).toMatchObject({
      name: "Northwind",
      displayCurrency: "USD",
      timeZone: "UTC",
      notifications: { payrollReady: true, payoutSettled: true, weeklySummary: false },
    });
  });

  it("the owner changes the name, currency, time zone and notices", async () => {
    const res = await patch(`/orgs/${orgId}/settings`, {
      name: "Northwind Ltd",
      displayCurrency: "NGN",
      timeZone: "Africa/Lagos",
      notifications: { payrollReady: true, payoutSettled: false, weeklySummary: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: "Northwind Ltd",
      displayCurrency: "NGN",
      timeZone: "Africa/Lagos",
    });
    const again = await app.inject({
      method: "GET",
      url: `/orgs/${orgId}/settings`,
      cookies: owner.cookies,
    });
    expect(again.json().notifications.weeklySummary).toBe(true);
  });

  it.each([
    [{ displayCurrency: "XXX" }],
    [{ timeZone: "Mars/Olympus" }],
    [{ name: "   " }],
    [{ notifications: { payrollReady: true } }],
    [{}],
    [{ treasuryAccountId: "evil.near" }],
  ])("refuses %j", async (body) => {
    expect((await patch(`/orgs/${orgId}/settings`, body)).statusCode).toBe(400);
  });

  it("only the owner can change settings; every member can read them", async () => {
    const preparer = await addMember(app, owner.cookies, orgId, "preparer");
    expect(
      (await patch(`/orgs/${orgId}/settings`, { displayCurrency: "EUR" }, preparer.cookies))
        .statusCode,
    ).toBe(403);
    const read = await app.inject({
      method: "GET",
      url: `/orgs/${orgId}/settings`,
      cookies: preparer.cookies,
    });
    expect(read.statusCode).toBe(200);
  });

  it("a stranger learns nothing about another organisation's settings", async () => {
    const stranger = await signIn(app);
    const res = await app.inject({
      method: "GET",
      url: `/orgs/${orgId}/settings`,
      cookies: stranger.cookies,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /fx", () => {
  it("serves the rates, their source and when they were fetched, to a signed-in person", async () => {
    const res = await app.inject({ method: "GET", url: "/fx", cookies: owner.cookies });
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.rates.NGN).toBe("1349.822603");
    expect(body.source.url).toBe("https://www.exchangerate-api.com");
    expect(body.fetchedAt).toBe(NOW.toISOString());
  });

  it("needs a session", async () => {
    expect((await app.inject({ method: "GET", url: "/fx" })).statusCode).toBe(401);
  });

  it("is simply unavailable when no rate source is configured", async () => {
    const bare = await h.build();
    const res = await bare.inject({ method: "GET", url: "/fx", cookies: owner.cookies });
    expect(res.json()).toEqual({ available: false });
    await bare.close();
  });
});

describe("members by email", () => {
  it("adds an existing email account by its address, and says so when there is none", async () => {
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "accountant@example.test", password: "a long enough passphrase" },
    });
    expect(signup.statusCode).toBe(201);
    const add = await app.inject({
      method: "POST",
      url: `/orgs/${orgId}/members`,
      cookies: owner.cookies,
      payload: { email: "Accountant@Example.test", role: "accountant" },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json().role).toBe("accountant");
    const members = await app.inject({
      method: "GET",
      url: `/orgs/${orgId}/members`,
      cookies: owner.cookies,
    });
    expect(
      members
        .json()
        .members.some((m: { email: string | null }) => m.email === "accountant@example.test"),
    ).toBe(true);
    const unknown = await app.inject({
      method: "POST",
      url: `/orgs/${orgId}/members`,
      cookies: owner.cookies,
      payload: { email: "nobody@example.test", role: "viewer" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("USER_NOT_FOUND");
    expect(await listOutboxFor(h.db, "nobody@example.test")).toHaveLength(0);
  });
});
