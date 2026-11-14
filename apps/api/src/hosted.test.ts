// The hosted deployment (slice W7): internal cron routes behind CRON_SECRET, the on-demand status
// refresh, the "what this deployment can do" route, and live quotes that fail closed when no 1Click
// partner key is set.
import { readFileSync } from "node:fs";
import { disconnectedDryClient, disconnectedTreasuryClient, LIVE_QUOTES_OFF } from "@veylo/intents";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bearerMatches, CRON_JOB_NAMES, type CronJobs } from "./cron-routes.js";
import { createHostedJobs } from "./hosted.js";
import { createHarness, createOrg, signIn, type App } from "./test-support.js";

const SECRET = "s".repeat(48);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe("bearerMatches", () => {
  it("accepts exactly `Bearer <secret>`", () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });
  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["the wrong secret", `Bearer ${"x".repeat(48)}`],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, 40)}`],
    ["the secret with more after it", `Bearer ${SECRET}x`],
    ["another scheme", `Basic ${SECRET}`],
    ["no scheme", SECRET],
    ["a lowercase scheme", `bearer ${SECRET}`],
    ["two tokens", `Bearer ${SECRET} ${SECRET}`],
    ["an array", [`Bearer ${SECRET}`]],
  ])("refuses %s", (_label, header) => {
    expect(bearerMatches(header, SECRET)).toBe(false);
  });
});

describe("the internal cron routes", () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let app: App;
  let off: App;
  const calls = { "prepare-drafts": 0, settlement: 0 };
  const jobs: CronJobs = {
    "prepare-drafts": async () => {
      calls["prepare-drafts"] += 1;
      return { created: 2 };
    },
    settlement: async () => {
      calls.settlement += 1;
      return { steps: [] };
    },
  };
  beforeAll(async () => {
    h = await createHarness();
    app = await h.build({ cron: { secret: SECRET, jobs } });
    off = await h.build();
  });
  afterAll(async () => {
    await app.close();
    await off.close();
    await h.client.close();
  });
  const get = (url: string, authorization?: string) =>
    app.inject({ method: "GET", url, ...(authorization ? { headers: { authorization } } : {}) });

  it.each(CRON_JOB_NAMES)("%s refuses a call without the secret and runs nothing", async (name) => {
    const before = calls[name];
    for (const header of [undefined, "Bearer nope", `Basic ${SECRET}`, SECRET]) {
      const res = await get(`/internal/cron/${name}`, header);
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain(SECRET);
    }
    expect(calls[name]).toBe(before);
  });

  it.each(CRON_JOB_NAMES)("%s runs once, with the secret, and is never cached", async (name) => {
    const before = calls[name];
    const res = await get(`/internal/cron/${name}`, `Bearer ${SECRET}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, job: name });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(calls[name]).toBe(before + 1);
  });

  it("is GET only", async () => {
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: "/internal/cron/settlement",
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it("a session cookie is not a substitute for the secret", async () => {
    const owner = await signIn(app);
    const res = await app.inject({
      method: "GET",
      url: "/internal/cron/settlement",
      cookies: owner.cookies,
    });
    expect(res.statusCode).toBe(401);
  });

  it("without CRON_SECRET configured the routes do not exist", async () => {
    for (const name of CRON_JOB_NAMES) {
      const res = await off.inject({
        method: "GET",
        url: `/internal/cron/${name}`,
        headers: { authorization: `Bearer ${SECRET}` },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("GET /features", () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.client.close();
  });
  const config = (extra: object) => ({
    authRecipient: "veylo.test",
    webOrigin: "https://app.veylo.test",
    sessionTtlHours: 24,
    logLevel: "silent",
    ...extra,
  });

  it("is public and says what is on", async () => {
    const app = await h.build();
    const res = await app.inject({ method: "GET", url: "/features" });
    expect(res.statusCode).toBe(200);
    // Tests wire a 1Click double; no email provider exists, so email delivery is off.
    expect(res.json()).toEqual({ emailDelivery: false, liveQuotes: true, fundingQuotes: true });
    await app.close();
  });

  it("says live quotes are off when no partner key is set", async () => {
    const app = await h.build({ config: config({ liveQuotes: false }) });
    const res = await app.inject({ method: "GET", url: "/features" });
    expect(res.json()).toEqual({ emailDelivery: false, liveQuotes: false, fundingQuotes: true });
    await app.close();
  });
});

describe("live quotes fail closed without a 1Click partner key", () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let app: App;
  beforeAll(async () => {
    h = await createHarness();
    app = await h.build({
      oneclick: disconnectedDryClient,
      oneclickTreasury: disconnectedTreasuryClient,
      config: {
        authRecipient: "veylo.test",
        webOrigin: "https://app.veylo.test",
        sessionTtlHours: 24,
        logLevel: "silent",
        liveQuotes: false,
      },
    });
  });
  afterAll(async () => {
    await app.close();
    await h.client.close();
  });

  it("a funding quote says so, in plain words, and sends nothing to 1Click", async () => {
    const owner = await signIn(app);
    const org = await createOrg(app, owner.cookies);
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${org.id}/treasury/funding-quote`,
      cookies: owner.cookies,
      payload: { originRoute: "usdc-base", amount: "1000", refundAddress: `0x${"1".repeat(40)}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: { code: "LIVE_QUOTES_OFF", message: LIVE_QUOTES_OFF },
    });
    expect(h.one.requests).toEqual([]);
  });

  it("starting quotes on a pay run says so before touching anything", async () => {
    const owner = await signIn(app);
    const org = await createOrg(app, owner.cookies);
    const run = await app.inject({
      method: "POST",
      url: `/orgs/${org.id}/pay-runs`,
      cookies: owner.cookies,
      payload: { period: "2026-11", mode: "live" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${org.id}/pay-runs/${run.json().id}/quote`,
      cookies: owner.cookies,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("LIVE_QUOTES_OFF");
  });

  it("every disconnected client call is refused with the same sentence and never reaches the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(disconnectedDryClient.dryQuote({} as never)).resolves.toEqual({
      outcome: "check_failed",
      reason: LIVE_QUOTES_OFF,
    });
    for (const call of [
      () => disconnectedTreasuryClient.referencePrice("x"),
      () => disconnectedTreasuryClient.status("x"),
      () => disconnectedTreasuryClient.balances("x"),
      () => disconnectedTreasuryClient.refresh("x"),
    ]) {
      await expect(call()).rejects.toMatchObject({
        kind: "not_connected",
        detail: LIVE_QUOTES_OFF,
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("the hosted jobs", () => {
  const settlement = () => ({
    pollPayoutStatus: vi.fn(async () => {}),
    resolveUncertainSubmits: vi.fn(async () => {}),
    expireQuotes: vi.fn(async () => {}),
    reconcilePayouts: vi.fn(async () => {}),
    releaseEncumbrances: vi.fn(async () => {}),
  });
  const scheduler = () => ({ prepareDue: vi.fn(async () => ({ created: 3 })) });
  let now = new Date("2026-11-13T10:00:00.000Z").getTime();
  const clock = () => new Date(now);

  it("the settlement cron runs all five sweeps, for every organisation, in order", async () => {
    const s = settlement();
    const jobs = createHostedJobs({ settlement: s, scheduler: scheduler(), clock, log: quiet });
    const out = await jobs.jobs.settlement(quiet);
    expect(out.steps).toEqual([
      { name: "poll-payout-status", status: "ok" },
      { name: "resolve-uncertain-submit", status: "ok" },
      { name: "expire-quotes", status: "ok" },
      { name: "reconcile-payout", status: "ok" },
      { name: "release-encumbrances", status: "ok" },
    ]);
    for (const fn of Object.values(s))
      expect(fn).toHaveBeenCalledWith(quiet, { shouldStop: expect.any(Function) });
  });

  it("one failing sweep does not stop the rest, and the cron call fails so the log shows it", async () => {
    const s = settlement();
    s.pollPayoutStatus.mockRejectedValueOnce(new Error("1Click down"));
    const jobs = createHostedJobs({ settlement: s, scheduler: scheduler(), clock, log: quiet });
    await expect(jobs.jobs.settlement(quiet)).rejects.toThrow("incomplete");
    expect(s.releaseEncumbrances).toHaveBeenCalledTimes(1);
  });

  it("starts no sweep after the time budget and says which were deferred", async () => {
    const s = settlement();
    s.pollPayoutStatus.mockImplementation(async () => {
      now += 500;
    });
    const jobs = createHostedJobs({
      settlement: s,
      scheduler: scheduler(),
      clock,
      log: quiet,
      cronBudgetMs: 100,
    });
    const steps = await jobs.runSweeps({}, 100);
    expect(steps.map((x) => x.status)).toEqual([
      "ok",
      "deferred",
      "deferred",
      "deferred",
      "deferred",
    ]);
    expect(s.resolveUncertainSubmits).not.toHaveBeenCalled();
  });

  it("the draft cron prepares drafts and reports how many", async () => {
    const sch = scheduler();
    const jobs = createHostedJobs({ settlement: settlement(), scheduler: sch, clock, log: quiet });
    expect(await jobs.jobs["prepare-drafts"](quiet)).toEqual({ created: 3 });
    expect(sch.prepareDue).toHaveBeenCalledTimes(1);
  });

  it("a status refresh is limited to one organisation", async () => {
    const s = settlement();
    const jobs = createHostedJobs({ settlement: s, scheduler: scheduler(), clock, log: quiet });
    await jobs.refresh("org-a");
    for (const fn of Object.values(s))
      expect(fn).toHaveBeenCalledWith(quiet, { orgId: "org-a", shouldStop: expect.any(Function) });
  });

  it("refreshes an organisation at most once in the interval, and again after it", async () => {
    const s = settlement();
    const jobs = createHostedJobs({
      settlement: s,
      scheduler: scheduler(),
      clock,
      log: quiet,
      refreshEveryMs: 10_000,
    });
    await jobs.refresh("org-a");
    await jobs.refresh("org-a");
    expect(s.pollPayoutStatus).toHaveBeenCalledTimes(1);
    await jobs.refresh("org-b");
    expect(s.pollPayoutStatus).toHaveBeenCalledTimes(2);
    now += 10_001;
    await jobs.refresh("org-a");
    expect(s.pollPayoutStatus).toHaveBeenCalledTimes(3);
  });

  it("a refresh never throws and never waits longer than its limit", async () => {
    const s = settlement();
    s.pollPayoutStatus.mockImplementation(() => new Promise<void>(() => {}));
    const jobs = createHostedJobs({
      settlement: s,
      scheduler: scheduler(),
      clock,
      log: quiet,
      refreshWaitMs: 30,
    });
    const started = Date.now();
    await expect(jobs.refresh("org-slow")).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    const s2 = settlement();
    s2.pollPayoutStatus.mockRejectedValue(new Error("boom"));
    const j2 = createHostedJobs({ settlement: s2, scheduler: scheduler(), clock, log: quiet });
    await expect(j2.refresh("org-x")).resolves.toBeUndefined();
  });
});

describe("the hosted code cannot quote, sign or submit anything new", () => {
  const code = (file: string) =>
    readFileSync(new URL(file, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  it("the cron routes and the hosted jobs name no quoting, signing or submitting", () => {
    for (const file of ["./cron-routes.ts", "./hosted.ts"]) {
      for (const forbidden of [
        /createPayoutQuote|createFundingQuote|createShieldQuote/,
        /submitIntent|\.submit\(/,
        /signRequest|signedData|signNep|\.sign\(/,
        /oneclickTreasury/,
      ])
        expect(code(file), `${file} ${String(forbidden)}`).not.toMatch(forbidden);
    }
  });
});

describe("the cron time limit (W7)", () => {
  const quietLog = { info: () => {}, warn: () => {}, error: () => {} };
  type Sweep = (log: unknown, scope?: { shouldStop?: () => boolean }) => Promise<void>;
  const sweep = () => vi.fn<Sweep>(async () => {});
  const fakes = () => ({
    settlement: {
      pollPayoutStatus: sweep(),
      resolveUncertainSubmits: sweep(),
      expireQuotes: sweep(),
      reconcilePayouts: sweep(),
      releaseEncumbrances: sweep(),
    },
    scheduler: { prepareDue: vi.fn(async () => ({ created: 0 })) },
  });

  it("the cutoff plus the worst row plus a margin fits inside the function's limit", async () => {
    const { CRON_CUTOFF_MS, FUNCTION_LIMIT_MS, SAFETY_MARGIN_MS, WORST_ROW_MS } =
      await import("./hosted.js");
    expect(CRON_CUTOFF_MS).toBeLessThan(FUNCTION_LIMIT_MS);
    expect(CRON_CUTOFF_MS + WORST_ROW_MS + SAFETY_MARGIN_MS).toBeLessThanOrEqual(FUNCTION_LIMIT_MS);
  });

  it("the default budget the jobs use is the cutoff, and the limit is within the free plan's 300 s", async () => {
    const { CRON_CUTOFF_MS, FUNCTION_LIMIT_MS } = await import("./hosted.js");
    const jobs = createHostedJobs({ ...fakes(), clock: () => new Date(), log: quietLog });
    expect(jobs.cronBudgetMs).toBe(CRON_CUTOFF_MS);
    expect(FUNCTION_LIMIT_MS).toBeLessThanOrEqual(300_000);
  });

  it("the deployment is built with a maxDuration that leaves the cutoff, the worst row and the margin room", async () => {
    const { spawnSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync: read, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { CRON_CUTOFF_MS, SAFETY_MARGIN_MS, WORST_ROW_MS } = await import("./hosted.js");
    const dir = mkdtempSync(join(tmpdir(), "veylo-vc-"));
    try {
      const script = fileURLToPath(new URL("../build-vercel.mjs", import.meta.url));
      const run = spawnSync(process.execPath, [script], {
        env: { ...process.env, VERCEL_API_DEPLOY_DIR: dir },
        encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
      const config = JSON.parse(
        read(join(dir, ".vercel", "output", "functions", "index.func", ".vc-config.json"), "utf8"),
      );
      const limitMs = config.maxDuration * 1000;
      // The failing condition the brief names: a cutoff at or past the limit.
      expect(CRON_CUTOFF_MS).toBeLessThan(limitMs);
      expect(CRON_CUTOFF_MS + WORST_ROW_MS + SAFETY_MARGIN_MS).toBeLessThanOrEqual(limitMs);
      expect(config.maxDuration).toBeLessThanOrEqual(300);
      expect(config.runtime).toBe("nodejs24.x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("a sweep is told to stop starting rows once the cutoff passes, and is reported as deferred", async () => {
    let now = new Date("2026-11-13T10:00:00.000Z").getTime();
    const f = fakes();
    const processed: number[] = [];
    f.settlement.pollPayoutStatus.mockImplementation(async (_log, scope) => {
      for (let row = 1; row <= 10; row += 1) {
        if (scope?.shouldStop?.()) return;
        processed.push(row);
        now += 10_000; // each row takes 10 s
      }
    });
    const jobs = createHostedJobs({ ...f, clock: () => new Date(now), log: quietLog });
    const steps = await jobs.runSweeps({}, 35_000);
    // Rows 1 to 4 start before 35 s; the fifth would start at 40 s, so it does not.
    expect(processed).toEqual([1, 2, 3, 4]);
    expect(steps[0]).toEqual({ name: "poll-payout-status", status: "deferred" });
    expect(steps.slice(1).every((s) => s.status === "deferred")).toBe(true);
  });

  it("every settlement sweep checks the clock before each row", () => {
    const source = readFileSync(new URL("./settlement.ts", import.meta.url), "utf8");
    const loops = source.match(/for \(const (?:row|e) of await list/g) ?? [];
    const checks = source.match(/scope\.shouldStop\?\.\(\)/g) ?? [];
    expect(loops.length).toBeGreaterThanOrEqual(6);
    expect(checks.length).toBeGreaterThanOrEqual(loops.length);
  });
});
