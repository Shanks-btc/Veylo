// Keyset pagination of the ledger and audit log (slice 6.1, L37): stable order across pages,
// including rows that tie on timestamp, and sub-millisecond timestamps a JS Date can't hold.
import { schema } from "@veylo/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, createOrg, signIn, type App } from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
let owner: Awaited<ReturnType<typeof signIn>>;
let orgId: string;
/** Every ledger row, as [microseconds since epoch, id]. */
const expected: [bigint, string][] = [];

const TIE = "2026-11-07T10:00:00.000000Z";
const TIE_US = BigInt(Date.parse(TIE)) * 1000n;

beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
  owner = await signIn(app);
  orgId = (await createOrg(app, owner.cookies)).id;
  const [run] = await h.db
    .insert(schema.payRuns)
    .values({
      orgId,
      period: "2026-11",
      status: "Completed",
      preparedBy: "user",
      totalAmountUsdc: 0n,
      mode: "live",
    })
    .returning();
  // Five payouts and four treasury events at exactly the same instant, plus two events 1 µs and
  // 2 µs later: a millisecond cursor would repeat or drop those.
  for (let i = 0; i < 5; i += 1) {
    const [c] = await h.db
      .insert(schema.contractors)
      .values({ orgId, name: `Tie Case ${i}`, terms: {}, payoutMode: "direct", status: "active" })
      .returning();
    const [item] = await h.db
      .insert(schema.payRunItems)
      .values({
        orgId,
        payRunId: run!.id,
        contractorId: c!.id,
        amountUsdc: 1n,
        basis: {},
        mode: "live",
      })
      .returning();
    const [a] = await h.db
      .insert(schema.payoutAttempts)
      .values({
        orgId,
        lineItemId: item!.id,
        attemptNo: 1,
        status: "SUCCESS",
        mode: "live",
        statusHistory: [],
        terminalAt: sql`${TIE}::timestamptz` as never,
      })
      .returning();
    expected.push([TIE_US, a!.id]);
  }
  for (let i = 0; i < 6; i += 1) {
    const offset = i < 4 ? 0 : i - 3;
    const at = `2026-11-07T10:00:00.00000${offset}Z`;
    const [e] = await h.db
      .insert(schema.treasuryEvents)
      .values({
        orgId,
        type: "fund",
        originAsset: "nep141:usdc",
        originAmount: "1",
        destinationAmount: 1n,
        quote: {},
        correlationId: `c${i}`,
        depositAddress: `keyset-deposit-${i}`,
        status: "SUCCESS",
        mode: "live",
        createdAt: sql`${at}::timestamptz` as never,
      })
      .returning();
    expected.push([TIE_US + BigInt(offset), e!.id]);
  }
  expected.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? 1 : -1) : a[0] < b[0] ? 1 : -1));
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

const get = (url: string) => app.inject({ method: "GET", url, cookies: owner.cookies });

async function walk(path: string, limit: number) {
  const ids: string[] = [];
  let cursor = "";
  for (let i = 0; i < 100; i += 1) {
    const res = (
      await get(
        `${path}${path.includes("?") ? "&" : "?"}limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
      )
    ).json();
    expect(res.items.length).toBeLessThanOrEqual(limit);
    ids.push(...res.items.map((x: { id: string }) => x.id));
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return ids;
}

describe("ledger keyset pagination", () => {
  it("one page holds everything, newest first, ties broken by id", async () => {
    const ids = (await get(`/orgs/${orgId}/ledger?limit=200`))
      .json()
      .items.map((x: { id: string }) => x.id);
    expect(ids).toEqual(expected.map(([, id]) => id));
  });

  it.each([1, 2, 3, 4, 10])(
    "pages of %i give the same order, with no repeats or gaps",
    async (n) => {
      const ids = await walk(`/orgs/${orgId}/ledger`, n);
      expect(ids).toEqual(expected.map(([, id]) => id));
    },
  );

  it("the last page has no cursor", async () => {
    const res = (await get(`/orgs/${orgId}/ledger?limit=${expected.length}`)).json();
    expect(res.items).toHaveLength(expected.length);
    expect(res.nextCursor).toBeNull();
  });

  it("filters are applied in the database, before the limit", async () => {
    const ids = await walk(`/orgs/${orgId}/ledger?status=SUCCESS`, 2);
    expect(ids).toHaveLength(expected.length);
    expect(await walk(`/orgs/${orgId}/ledger?mode=simulated`, 2)).toEqual([]);
  });

  it.each([
    Buffer.from(JSON.stringify({ at: "2026-11-07", id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ us: "1.5", id: "00000000-0000-0000-0000-000000000000" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify({ us: "1", id: "not-a-uuid" })).toString("base64url"),
  ])("rejects a malformed cursor %#", async (c) => {
    expect((await get(`/orgs/${orgId}/ledger?cursor=${c}`)).statusCode).toBe(400);
  });
});

describe("audit keyset pagination", () => {
  it("pages the audit log in a stable order", async () => {
    const all = (await get(`/orgs/${orgId}/audit?limit=200`))
      .json()
      .items.map((x: { id: string }) => x.id);
    expect(all.length).toBeGreaterThan(0);
    expect(await walk(`/orgs/${orgId}/audit`, 1)).toEqual(all);
  });
});
