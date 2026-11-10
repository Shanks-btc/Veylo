import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, createHarness, createOrg, signIn, type App } from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
const CONFIG = {
  authRecipient: "veylo.test",
  webOrigin: "https://app.veylo.test",
  sessionTtlHours: 24 * 30,
  logLevel: "silent",
  treasuryLimitPerOrgPerHour: 3,
  treasuryLimitPerUserPerHour: 2,
};
const REFUND = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
const FUNDING = { originRoute: "usdc-base", amount: "1000", refundAddress: REFUND };
beforeAll(async () => {
  h = await createHarness();
  app = await h.build({ config: CONFIG });
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

const post = (url: string, cookies: Record<string, string>, payload?: object) =>
  app.inject({ method: "POST", url, cookies, ...(payload ? { payload } : {}) });

describe.each([
  ["funding-quote", FUNDING],
  ["shield-request", { amount: "1000" }],
  ["session-request", undefined],
] as const)("%s", (route, payload) => {
  async function org() {
    const owner = await signIn(app);
    const created = await createOrg(app, owner.cookies);
    return { ...owner, url: `/orgs/${created.id}/treasury/${route}`, orgId: created.id };
  }

  it("limits a user, with the standard error, and reaches 1Click no further", async () => {
    const s = await org();
    expect((await post(s.url, s.cookies, payload)).statusCode).toBe(201);
    expect((await post(s.url, s.cookies, payload)).statusCode).toBe(201);
    h.one.requests.length = 0;
    const res = await post(s.url, s.cookies, payload);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("RATE_LIMITED");
    expect(h.one.requests).toEqual([]);
  });

  it("limits an org across its users", async () => {
    const s = await org();
    const other = await addMember(app, s.cookies, s.orgId, "owner");
    expect((await post(s.url, s.cookies, payload)).statusCode).toBe(201);
    expect((await post(s.url, s.cookies, payload)).statusCode).toBe(201);
    expect((await post(s.url, other.cookies, payload)).statusCode).toBe(201);
    expect((await post(s.url, other.cookies, payload)).statusCode).toBe(429);
  });

  it("another org is unaffected, and the window resets", async () => {
    const s = await org();
    await post(s.url, s.cookies, payload);
    await post(s.url, s.cookies, payload);
    const other = await org();
    expect((await post(other.url, other.cookies, payload)).statusCode).toBe(201);
    const start = h.clock.now;
    h.clock.now = new Date(start.getTime() + 3_600_000);
    const fresh = await signIn(app, s.wallet);
    expect((await post(s.url, fresh.cookies, payload)).statusCode).toBe(201);
    h.clock.now = start;
  });
});

describe("limits", () => {
  it("count each route separately", async () => {
    const owner = await signIn(app);
    const { id } = await createOrg(app, owner.cookies);
    const url = `/orgs/${id}/treasury`;
    await post(`${url}/session-request`, owner.cookies);
    await post(`${url}/session-request`, owner.cookies);
    expect((await post(`${url}/session-request`, owner.cookies)).statusCode).toBe(429);
    expect((await post(`${url}/shield-request`, owner.cookies, { amount: "1" })).statusCode).toBe(
      201,
    );
  });

  it("a non-member's denied request doesn't use up the org's limit", async () => {
    const owner = await signIn(app);
    const { id } = await createOrg(app, owner.cookies);
    const url = `/orgs/${id}/treasury/session-request`;
    const stranger = await signIn(app);
    for (let i = 0; i < 5; i += 1) {
      expect((await post(url, stranger.cookies)).statusCode).toBe(404);
    }
    expect((await post(url, owner.cookies)).statusCode).toBe(201);
  });
});
