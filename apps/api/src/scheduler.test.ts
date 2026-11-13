// Recurring payroll (slice W5, D1): the worker prepares a draft three days before payday and
// marks it ready for review. It never quotes, signs or submits.
import { readFileSync } from "node:fs";
import { schema } from "@veylo/db";
import { count } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createScheduler, type Reminder } from "./scheduler.js";
import { addMember, createHarness, createOrg, signIn, type App } from "./test-support.js";

const quiet = { info: () => {}, error: () => {} };
const at = (iso: string) => new Date(iso);

describe("the scheduled-payroll job has no way to quote, sign or submit", () => {
  const source = readFileSync(new URL("./scheduler.ts", import.meta.url), "utf8");
  // Code only: comments explain the rule and are allowed to name what the job can't do.
  const code = source
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  it("its source names no quoting, signing, submitting, settlement or treasury client", () => {
    for (const forbidden of [
      /oneclick/i,
      /createPayoutQuote/,
      /submit/i,
      /signRequest|sign-request|signedData|signNep|\.sign\(/,
      /settlement/i,
      /treasuryClient|TreasuryClient/,
    ])
      expect(code, String(forbidden)).not.toMatch(forbidden);
  });

  it("imports only core and the database package", () => {
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@veylo/core", "@veylo/db"]);
  });

  it("is created from a database and a clock, nothing else", () => {
    expect(source).toMatch(/export type SchedulerDeps = \{ db: Db; clock: \(\) => Date \};/);
  });
});

describe("preparing drafts", () => {
  let h: Awaited<ReturnType<typeof createHarness>>;
  let app: App;
  let cookies: Record<string, string>;
  let orgId: string;
  const scheduler = () => createScheduler({ db: h.db, clock: () => h.clock.now });

  const api = (method: "GET" | "PUT" | "POST", url: string, payload?: object, as = cookies) =>
    app.inject({ method, url: `/orgs/${orgId}${url}`, cookies: as, payload });
  const contractor = async (name: string, terms: object) =>
    ((await api("POST", "/contractors", { name, terms })).json() as { id: string }).id;
  const drafts = async () =>
    (await h.db.select().from(schema.payRuns)).filter((r) => r.orgId === orgId);
  const monthly = (dayOfMonth: number, timeZone = "UTC") => ({
    kind: "monthly",
    dayOfMonth,
    timeZone,
  });

  beforeAll(async () => {
    h = await createHarness();
    app = await h.build();
  });
  afterAll(async () => {
    await app.close();
    await h.client.close();
  });
  beforeEach(async () => {
    // The job looks at every organisation's schedule; each test starts with only its own.
    await h.db.delete(schema.payrollSchedules);
    const owner = await signIn(app);
    cookies = owner.cookies;
    orgId = (await createOrg(app, cookies)).id;
  });

  it("prepares nothing four days before payday, and one draft three days before", async () => {
    await api("PUT", "/payroll-schedule", monthly(15));
    await contractor("Ada", { kind: "fixed", rate: "5000000", schedule: "monthly" });
    h.clock.now = at("2026-11-11T12:00:00Z");
    expect(await scheduler().prepareDue(quiet)).toEqual({ created: 0 });
    h.clock.now = at("2026-11-12T12:00:00Z");
    expect(await scheduler().prepareDue(quiet)).toEqual({ created: 1 });
    const [run] = await drafts();
    expect(run).toMatchObject({ status: "Draft", period: "2026-11", scheduledFor: "2026-11-15" });
    expect(run?.readyForReviewAt).toEqual(h.clock.now);
  });

  it("adds an item for each active contractor on a fixed rate that matches the rhythm, and totals them", async () => {
    await api("PUT", "/payroll-schedule", monthly(15));
    await contractor("Ada", { kind: "fixed", rate: "5000000", schedule: "monthly" });
    await contractor("Bo", { kind: "fixed", rate: "2500000", schedule: "monthly" });
    await contractor("Hourly Hal", { kind: "hourly", rate: "100", schedule: "monthly" });
    await contractor("Weekly Wes", { kind: "fixed", rate: "1000000", schedule: "weekly" });
    const archived = await contractor("Gone Gil", {
      kind: "fixed",
      rate: "9000000",
      schedule: "monthly",
    });
    await api("POST", `/contractors/${archived}/archive`);
    h.clock.now = at("2026-11-13T12:00:00Z");
    await scheduler().prepareDue(quiet);
    const [run] = await drafts();
    const items = await h.db.select().from(schema.payRunItems);
    expect(
      items
        .filter((i) => i.payRunId === run?.id)
        .map((i) => i.amountUsdc)
        .sort(),
    ).toEqual([2_500_000n, 5_000_000n]);
    expect(run?.totalAmountUsdc).toBe(7_500_000n);
  });

  it("is idempotent: running again, or twice at once, never makes a second draft", async () => {
    await api("PUT", "/payroll-schedule", monthly(15));
    await contractor("Ada", { kind: "fixed", rate: "5000000", schedule: "monthly" });
    h.clock.now = at("2026-11-13T12:00:00Z");
    await scheduler().prepareDue(quiet);
    expect(await scheduler().prepareDue(quiet)).toEqual({ created: 0 });
    await Promise.all([scheduler().prepareDue(quiet), scheduler().prepareDue(quiet)]);
    h.clock.now = at("2026-11-15T23:00:00Z");
    await scheduler().prepareDue(quiet);
    expect(await drafts()).toHaveLength(1);
  });

  it("never prepares a payday that has already passed", async () => {
    await api("PUT", "/payroll-schedule", monthly(15));
    h.clock.now = at("2026-11-16T12:00:00Z");
    expect(await scheduler().prepareDue(quiet)).toEqual({ created: 0 });
    expect(await drafts()).toHaveLength(0);
  });

  it("a paused schedule prepares nothing; resuming prepares the draft that is due", async () => {
    await api("PUT", "/payroll-schedule", monthly(15));
    h.clock.now = at("2026-11-13T12:00:00Z");
    const paused = await api("POST", "/payroll-schedule/pause");
    expect(paused.json()).toMatchObject({ schedule: { paused: true }, next: null });
    expect(await scheduler().prepareDue(quiet)).toEqual({ created: 0 });
    const resumed = await api("POST", "/payroll-schedule/resume");
    expect(resumed.json()).toMatchObject({
      schedule: { paused: false },
      next: { payday: "2026-11-15" },
    });
    expect(await scheduler().prepareDue(quiet)).toEqual({ created: 1 });
  });

  it("uses the organisation's time zone: a Pacific/Auckland payday is prepared on Auckland's date", async () => {
    await api("PUT", "/payroll-schedule", monthly(3, "Pacific/Auckland"));
    h.clock.now = at("2026-11-29T12:30:00Z"); // already Nov 30 in Auckland: payday Dec 3 is due
    expect(await scheduler().prepareDue(quiet)).toEqual({ created: 1 });
    expect((await drafts())[0]?.scheduledFor).toBe("2026-12-03");
  });

  it("month-end: a 31st payday in a 30-day month is the 30th, in February the 28th", async () => {
    await api("PUT", "/payroll-schedule", monthly(31));
    h.clock.now = at("2026-04-27T09:00:00Z");
    await scheduler().prepareDue(quiet);
    h.clock.now = at("2027-02-25T09:00:00Z");
    await scheduler().prepareDue(quiet);
    expect((await drafts()).map((r) => r.scheduledFor).sort()).toEqual([
      "2026-04-30",
      "2027-02-28",
    ]);
  });

  it("biweekly schedules prepare every second Friday", async () => {
    await api("PUT", "/payroll-schedule", {
      kind: "biweekly",
      anchorDate: "2026-11-13",
      timeZone: "UTC",
    });
    for (const day of ["2026-11-10", "2026-11-24", "2026-12-08"]) {
      h.clock.now = at(`${day}T08:00:00Z`);
      await scheduler().prepareDue(quiet);
    }
    expect((await drafts()).map((r) => r.scheduledFor).sort()).toEqual([
      "2026-11-13",
      "2026-11-27",
      "2026-12-11",
    ]);
  });

  it("never quotes or signs: the draft has no payout attempt and stays a draft", async () => {
    await api("PUT", "/payroll-schedule", monthly(15));
    await contractor("Ada", { kind: "fixed", rate: "5000000", schedule: "monthly" });
    h.clock.now = at("2026-11-13T12:00:00Z");
    h.quote.requests.length = 0;
    await scheduler().prepareDue(quiet);
    const [attempts] = await h.db.select({ n: count() }).from(schema.payoutAttempts);
    expect(attempts?.n).toBe(0);
    expect(h.quote.requests).toEqual([]);
    expect(h.one.requests).toEqual([]);
    expect((await drafts())[0]?.status).toBe("Draft");
  });

  it("the pay run list says which drafts are ready for review (the reminder banner)", async () => {
    await api("PUT", "/payroll-schedule", monthly(15));
    h.clock.now = at("2026-11-13T12:00:00Z");
    await scheduler().prepareDue(quiet);
    const list = (await api("GET", "/pay-runs")).json() as {
      payRuns: { readyForReview: boolean; scheduledFor: string | null }[];
    };
    expect(list.payRuns).toMatchObject([{ readyForReview: true, scheduledFor: "2026-11-15" }]);
  });

  it("the email reminder is off by default and only fires when enabled", async () => {
    await api("PUT", "/payroll-schedule", monthly(15));
    h.clock.now = at("2026-11-13T12:00:00Z");
    const sent: string[] = [];
    const reminder: Reminder = { enabled: false, send: async (r) => void sent.push(r.period) };
    await createScheduler({ db: h.db, clock: () => h.clock.now }, reminder).prepareDue(quiet);
    expect(sent).toEqual([]);
    h.clock.now = at("2026-12-13T12:00:00Z");
    await api("PUT", "/payroll-schedule", monthly(15));
    await createScheduler(
      { db: h.db, clock: () => h.clock.now },
      { ...reminder, enabled: true },
    ).prepareDue(quiet);
    expect(sent).toEqual(["2026-12"]);
  });
});

describe("the schedule routes", () => {
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

  it("validates the schedule, and only the owner changes it", async () => {
    const owner = await signIn(app);
    const org = await createOrg(app, owner.cookies);
    const put = (payload: object, cookies = owner.cookies) =>
      app.inject({ method: "PUT", url: `/orgs/${org.id}/payroll-schedule`, cookies, payload });
    expect((await put({ kind: "monthly", dayOfMonth: 32, timeZone: "UTC" })).statusCode).toBe(400);
    expect(
      (await put({ kind: "monthly", dayOfMonth: 5, timeZone: "Mars/Olympus" })).statusCode,
    ).toBe(400);
    expect(
      (await put({ kind: "biweekly", anchorDate: "2026-02-31", timeZone: "UTC" })).statusCode,
    ).toBe(400);
    expect(
      (await put({ kind: "monthly", dayOfMonth: 5, timeZone: "UTC", extra: 1 })).statusCode,
    ).toBe(400);
    expect(
      (await put({ kind: "monthly", dayOfMonth: 5, timeZone: "Europe/Berlin" })).statusCode,
    ).toBe(200);
    const prep = await addMember(app, owner.cookies, org.id, "preparer");
    expect(
      (await put({ kind: "monthly", dayOfMonth: 6, timeZone: "UTC" }, prep.cookies)).statusCode,
    ).toBe(403);
  });

  it("pausing an organisation with no schedule is a 404", async () => {
    const owner = await signIn(app);
    const org = await createOrg(app, owner.cookies);
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${org.id}/payroll-schedule/pause`,
      cookies: owner.cookies,
    });
    expect(res.statusCode).toBe(404);
  });
});
