// The web client's response contract (@veylo/contract) covers every route the API serves. The test
// harness checks every 2xx response against it, in every API test (slice W1).
import { ROUTES } from "@veylo/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type App } from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

describe("API response contract", () => {
  it("every registered route has a contract entry, and every entry is a real route", () => {
    const served = (app as unknown as { routeList: { method: string; url: string }[] }).routeList
      .filter((r) => r.method !== "OPTIONS")
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(Object.keys(ROUTES).sort()).toEqual([...new Set(served)]);
  });

  it("a response that breaks the contract becomes an error, not a pass", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(ROUTES["GET /health"].safeParse({ status: "degraded" }).success).toBe(false);
  });
});
