// The demo world (C3): honest data passes every gate, redirected data is refused, and every
// answer the demo gives matches the shared API contract.
import { ROUTES, type RouteKey } from "@veylo/contract";
import { describe, expect, it } from "vitest";
import { createApiClient } from "../api/client";
import { checkChallenge } from "../auth/sign-in";
import { runGates } from "../gates";
import { checklist } from "../signing/pay-run";
import { createDemoWorld } from "./world";

const cfg = (w: ReturnType<typeof createDemoWorld>) =>
  createApiClient({ origin: "https://demo.invalid", fetch: w.fetch as typeof fetch });

async function check(w: ReturnType<typeof createDemoWorld>) {
  const api = cfg(w);
  const { ORG, OPEN_RUN, ITEM_OPEN } = w.ids;
  const run = await api.call("GET /orgs/:orgId/pay-runs/:payRunId", {
    params: { orgId: ORG, payRunId: OPEN_RUN },
  });
  const registry = await api.call("GET /orgs/:orgId/payee-registry", { params: { orgId: ORG } });
  const item = run.items.find((i) => i.id === ITEM_OPEN)!;
  const signRequest = await api.call(
    "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request",
    {
      params: { orgId: ORG, payRunId: OPEN_RUN, itemId: ITEM_OPEN },
    },
  );
  const account = await w.wallet.connect();
  const report = await runGates({
    orgId: ORG,
    treasuryAccountId: account.accountId,
    walletPublicKey: account.publicKey ?? "",
    authRecipient: w.authRecipient,
    deadlineMinutes: 15,
    registry,
    items: [{ item, signRequest }],
    rpc: w.gateRpc,
    highWater: w.highWater,
    now: w.now(),
  });
  return report;
}

async function signInDemo(w: ReturnType<typeof createDemoWorld>) {
  await w.fetch(new URL("/auth/verify", "https://demo.invalid"), { method: "POST" });
}

describe("demo world", () => {
  it("the honest pay run passes every gate, with NEAR Intents' real signature on the quote", async () => {
    const w = createDemoWorld();
    const report = await check(w);
    expect(report.items[0]?.gates.map((g) => [g.gate, g.passed, g.reason])).toEqual([
      ["A", true, "ok"],
      ["deadline", true, "ok"],
      ["B", true, "ok"],
      ["B2", true, "ok"],
      ["C", true, "ok"],
    ]);
    expect(report.allPassed).toBe(true);
  });

  it("a payee address swapped by a compromised server is refused, and the checklist says which check failed", async () => {
    const w = createDemoWorld();
    w.setTampered(true);
    const report = await check(w);
    expect(report.allPassed).toBe(false);
    const failed = report.items[0]!.gates.filter((g) => !g.passed).map((g) => g.gate);
    expect(failed).toContain("A"); // the quote was altered after NEAR Intents signed it
    expect(failed).toContain("B"); // the payee list no longer matches what the owner signed
    const rows = checklist(report, new Map([[w.ids.ITEM_OPEN, "Kwame (demo)"]]));
    expect(rows.find((r) => r.id === "A")?.state).toBe("fail");
    expect(rows.find((r) => r.id === "B")?.state).toBe("fail");
  });

  it("restoring the server data makes the same run pass again", async () => {
    const w = createDemoWorld();
    w.setTampered(true);
    expect((await check(w)).allPassed).toBe(false);
    w.setTampered(false);
    expect((await check(w)).allPassed).toBe(true);
  });

  it("every demo answer matches the shared API contract", async () => {
    const w = createDemoWorld();
    await signInDemo(w);
    const { ORG, OPEN_RUN, DONE_RUN, KWAME, ADA, ITEM_DIRECT, ITEM_PRIVATE } = w.ids;
    const gets: [RouteKey, string][] = [
      ["GET /me", "/me"],
      ["GET /orgs/:orgId", `/orgs/${ORG}`],
      ["GET /orgs/:orgId/treasury/balances", `/orgs/${ORG}/treasury/balances`],
      ["GET /orgs/:orgId/pay-runs", `/orgs/${ORG}/pay-runs`],
      ["GET /orgs/:orgId/pay-runs/:payRunId", `/orgs/${ORG}/pay-runs/${OPEN_RUN}`],
      ["GET /orgs/:orgId/pay-runs/:payRunId", `/orgs/${ORG}/pay-runs/${DONE_RUN}`],
      ["GET /orgs/:orgId/payee-registry", `/orgs/${ORG}/payee-registry`],
      ["GET /orgs/:orgId/contractors", `/orgs/${ORG}/contractors`],
      ["GET /orgs/:orgId/contractors/:contractorId", `/orgs/${ORG}/contractors/${KWAME}`],
      [
        "GET /orgs/:orgId/contractors/:contractorId/destinations",
        `/orgs/${ORG}/contractors/${KWAME}/destinations`,
      ],
      [
        "GET /orgs/:orgId/contractors/:contractorId/destinations",
        `/orgs/${ORG}/contractors/${ADA}/destinations`,
      ],
      ["GET /orgs/:orgId/ledger", `/orgs/${ORG}/ledger`],
      [
        "GET /orgs/:orgId/pay-runs/:payRunId/items/:itemId/payslip",
        `/orgs/${ORG}/pay-runs/${DONE_RUN}/items/${ITEM_DIRECT}/payslip`,
      ],
      [
        "GET /orgs/:orgId/pay-runs/:payRunId/items/:itemId/payslip",
        `/orgs/${ORG}/pay-runs/${DONE_RUN}/items/${ITEM_PRIVATE}/payslip`,
      ],
    ];
    for (const [key, path] of gets) {
      const schema = ROUTES[key];
      if (schema === "csv") continue;
      const res = await w.fetch(new URL(path, "https://demo.invalid"));
      const parsed = schema.safeParse(await res.json());
      expect(
        parsed.success,
        `${key} ${path}: ${parsed.success ? "" : parsed.error.message.slice(0, 300)}`,
      ).toBe(true);
    }
  });

  it("signing in uses the live API's challenge format, and /me answers 401 until then", async () => {
    const w = createDemoWorld();
    const api = cfg(w);
    await expect(api.call("GET /me")).rejects.toMatchObject({ status: 401 });
    const wallet = await w.wallet.connect();
    const challenge = await api.call("POST /auth/challenge", {
      body: { accountId: wallet.accountId },
    });
    const nonce = checkChallenge(challenge, {
      accountId: wallet.accountId,
      authRecipient: w.authRecipient,
      now: new Date(),
    });
    expect(nonce).toHaveLength(32);
    await api.call("POST /auth/verify", {
      body: { accountId: wallet.accountId, publicKey: "k", signature: "s", nonce: challenge.nonce },
    });
    expect(w.isSignedIn()).toBe(true);
    await expect(api.call("GET /me")).resolves.toMatchObject({
      user: { nearAccountId: wallet.accountId },
    });
    await api.call("POST /auth/logout");
    expect(w.isSignedIn()).toBe(false);
  });

  it("anything not in the demo is read-only, and nothing is saved", async () => {
    const w = createDemoWorld();
    const res = await w.fetch(new URL("/orgs", "https://demo.invalid"), { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "DEMO_READ_ONLY" } });
  });
});
