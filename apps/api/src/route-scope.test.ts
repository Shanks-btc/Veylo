// NEAR-only scope (L46): with the production route set, the API refuses Base, Arbitrum, Solana and
// the not-yet-proven NEAR direct route, and accepts the confidential NEAR route.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, createOrg, RECIPIENT, signIn, type App } from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
beforeAll(async () => {
  h = await createHarness();
  // No enabledPayoutRoutes: the production default from @veylo/core applies.
  app = await h.build({
    config: {
      authRecipient: RECIPIENT,
      webOrigin: "https://app.veylo.test",
      sessionTtlHours: 24,
      logLevel: "silent",
    },
  });
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

describe("payout routes in scope (L46)", () => {
  it.each([
    ["usdc-base", "0xAf780910c0E7D41430D4615A437676a87a332C8C"],
    ["usdc-arbitrum", "0xAf780910c0E7D41430D4615A437676a87a332C8C"],
    ["usdc-solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    ["usdc-near", "ada-l.near"],
  ])("refuses a new %s address", async (route, address) => {
    const owner = await signIn(app);
    const org = await createOrg(app, owner.cookies);
    const c = await app.inject({
      method: "POST",
      url: `/orgs/${org.id}/contractors`,
      cookies: owner.cookies,
      payload: { name: "Ada", terms: { kind: "fixed", rate: "1000000", schedule: "monthly" } },
    });
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${org.id}/contractors/${(c.json() as { id: string }).id}/destinations`,
      cookies: owner.cookies,
      payload: { route, address },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "ROUTE_NOT_ENABLED" } });
  });
});
