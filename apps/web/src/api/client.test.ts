import { describe, expect, it, vi } from "vitest";
import { ApiContractError, ApiError, buildPath, createApiClient } from "./client.js";

const ORIGIN = "https://api.veylo.test";
const ORG = "11111111-1111-4111-8111-111111111111";
const reply = (body: unknown, status = 200, type = "application/json") =>
  vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": type },
      }),
  );

describe("typed API client", () => {
  it("validates a good response and sends the session cookie, never a token", async () => {
    const fetch = reply({ id: ORG, name: "Acme", treasuryAccountId: "acme.near" });
    const api = createApiClient({ origin: ORIGIN, fetch: fetch as never });
    await expect(api.call("GET /orgs/:orgId", { params: { orgId: ORG } })).resolves.toEqual({
      id: ORG,
      name: "Acme",
      treasuryAccountId: "acme.near",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`${ORIGIN}/orgs/${ORG}`);
    expect(init.credentials).toBe("include");
    expect(init.redirect).toBe("error");
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });

  it("an invalid response is an error, and none of it is returned", async () => {
    const api = createApiClient({
      origin: ORIGIN,
      fetch: reply({ id: ORG, name: "Acme", treasuryAccountId: 42 }) as never,
    });
    await expect(api.call("GET /orgs/:orgId", { params: { orgId: ORG } })).rejects.toBeInstanceOf(
      ApiContractError,
    );
  });

  it("a gate bundle missing a field is rejected whole", async () => {
    const api = createApiClient({
      origin: ORIGIN,
      fetch: reply({ head: { version: 1 }, approvals: [] }) as never,
    });
    await expect(
      api.call("GET /orgs/:orgId/payee-registry", { params: { orgId: ORG } }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("an API error body becomes ApiError; anything else is a contract error", async () => {
    const bad = createApiClient({
      origin: ORIGIN,
      fetch: reply({ error: { code: "NOT_FOUND", message: "Not found" } }, 404) as never,
    });
    await expect(bad.call("GET /me")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "NOT_FOUND",
    });
    const html = createApiClient({
      origin: ORIGIN,
      fetch: reply("<html>", 502, "text/html") as never,
    });
    await expect(html.call("GET /me")).rejects.toBeInstanceOf(ApiContractError);
    expect(new ApiError(400, "X", "y")).toBeInstanceOf(Error);
  });

  it("refuses non-JSON, unreachable APIs, and a CSV route that isn't CSV", async () => {
    const text = createApiClient({
      origin: ORIGIN,
      fetch: reply("not json", 200, "text/plain") as never,
    });
    await expect(text.call("GET /health")).rejects.toBeInstanceOf(ApiContractError);
    const down = createApiClient({
      origin: ORIGIN,
      fetch: vi.fn(() => Promise.reject(new Error("offline"))) as never,
    });
    await expect(down.call("GET /health")).rejects.toBeInstanceOf(ApiContractError);
    const csv = createApiClient({ origin: ORIGIN, fetch: reply('{"a":1}') as never });
    await expect(
      csv.call("GET /orgs/:orgId/exports/payouts.csv", {
        params: { orgId: ORG },
        query: { from: "2026-11-01", to: "2026-11-30" },
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("path parameters can't inject a path or leave the API origin", () => {
    expect(buildPath("/orgs/:orgId", { orgId: ORG })).toBe(`/orgs/${ORG}`);
    for (const orgId of ["../admin", "a/b", "x?y=1", "//evil.example", "", "%2e%2e"]) {
      expect(() => buildPath("/orgs/:orgId", { orgId })).toThrow(ApiContractError);
    }
    expect(() => buildPath("/orgs/:orgId", {})).toThrow(ApiContractError);
  });
});
