import { schema } from "@veylo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN,
  addMember,
  createHarness,
  createOrg,
  RECIPIENT,
  REFRESH_TOKEN,
  signIn,
  type App,
} from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
let owner: Awaited<ReturnType<typeof signIn>>;
let orgId: string;
let runId: string;
const items: Record<string, string> = {};

const EVM = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
const BASE_TX = "0xb8f7cd70174d9c3a951f137d1de7b76e4dcfdffd1fc11c78dc290b1fc0fb4aa8";
const NEAR_TX = "7Mm6ctWXUEdAFFfbZuH8V4NNpKeggfTrQxRf1vkBKgx";
const DEPOSIT = "8993545ee9c93a932549745951a5d80336a263a627808fbe0989091000c7f372";
const T = (m: number) => new Date(Date.UTC(2026, 10, 7, 10, m));

async function contractor(name: string, address: string, route = "usdc-base") {
  const [c] = await h.db
    .insert(schema.contractors)
    .values({ orgId, name, terms: {}, payoutMode: "direct", status: "active" })
    .returning();
  const [d] = await h.db
    .insert(schema.payoutDestinations)
    .values({
      orgId,
      contractorId: c!.id,
      route,
      payoutMode: route === "usdc-near-confidential" ? "private" : "direct",
      chain: route === "usdc-arbitrum" ? "arb" : "base",
      assetId: "a",
      address,
    })
    .returning();
  return { contractorId: c!.id, destinationId: d!.id };
}

async function payout(
  key: string,
  runIdFor: string,
  c: { contractorId: string; destinationId: string },
  amount: bigint,
  attempt: Partial<typeof schema.payoutAttempts.$inferInsert>,
  mode: "live" | "simulated" = "live",
) {
  const [item] = await h.db
    .insert(schema.payRunItems)
    .values({ orgId, payRunId: runIdFor, ...c, amountUsdc: amount, basis: {}, mode })
    .returning();
  items[key] = item!.id;
  await h.db.insert(schema.payoutAttempts).values({
    orgId,
    lineItemId: item!.id,
    attemptNo: 1,
    status: "SUCCESS",
    mode,
    statusHistory: [
      { status: "PLANNED", at: T(0).toISOString() },
      { status: "SUCCESS", at: T(5).toISOString() },
    ],
    quote: { timestamp: "2026-11-07T10:00:00.000Z" },
    fees: { withdrawFee: "2400", fee: "2413" },
    minAmountIn: amount + 2413n,
    amountIn: amount + 2943n,
    ...attempt,
  });
}

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
  runId = run!.id;
  const [sim] = await h.db
    .insert(schema.payRuns)
    .values({
      orgId,
      period: "2026-11",
      status: "Signing",
      preparedBy: "user",
      totalAmountUsdc: 0n,
      mode: "simulated",
    })
    .returning();

  const ada = await contractor("Ada Lovelace", EVM);
  const evil = await contractor('=HYPERLINK("http://evil","x")', EVM, "usdc-arbitrum");
  const bo = await contractor('Bo "the, quoted" Li', EVM);
  await payout("ada", runId, ada, 50000n, {
    intentHash: "ih-ada",
    depositAddress: DEPOSIT,
    nearTxHashes: [NEAR_TX],
    destinationTxHash: BASE_TX,
    reconciledAt: T(6),
    refundedAmount: 530n,
    terminalAt: T(5),
  });
  await payout("evil", runId, evil, 1234567n, {
    intentHash: "ih-evil",
    depositAddress: `${DEPOSIT.slice(0, 63)}a`,
    status: "REFUNDED",
    terminalAt: T(7),
    refundedAmount: 1237510n,
  });
  await payout("bo", runId, bo, 100000n, {
    intentHash: "ih-bo",
    depositAddress: `${DEPOSIT.slice(0, 63)}b`,
    status: "FAILED",
    failureReason: "settlement_failed",
    terminalAt: T(8),
  });
  await payout(
    "sim",
    sim!.id,
    await contractor("Sim Ulated", EVM),
    777n,
    {
      intentHash: "ih-sim",
      terminalAt: T(9),
    },
    "simulated",
  );
  await payout("notSubmitted", sim!.id, await contractor("Never Sent", EVM), 999n, {
    status: "EXPIRED",
    mode: "live",
    terminalAt: T(10),
  });
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

const get = (url: string, cookies = owner.cookies) => app.inject({ method: "GET", url, cookies });

describe("CSV export", () => {
  const csv = async () =>
    (await get(`/orgs/${orgId}/exports/payouts.csv?from=2026-11-07&to=2026-11-07`)).body;

  it("has the agreed header, CRLF lines, and only live payouts that reached 1Click", async () => {
    const text = await csv();
    const lines = text.split("\r\n");
    expect(lines[0]).toBe(
      "date,pay run period,contractor name,amount,currency,paid currency,paid amount,rate (USDC per NEAR),quote time,route,chain,recipient,delivery fee,total fee,status,reconciled,refunded amount,deposit address,intent hash,NEAR tx hash,destination tx hash,destination explorer URL,transaction link,payslip ID",
    );
    expect(lines.at(-1)).toBe("");
    expect(lines).toHaveLength(5); // Header, 3 rows, trailing newline.
    expect(text).not.toContain("Sim Ulated");
    expect(text).not.toContain("Never Sent");
  });

  it("formats amounts exactly, with 6 decimals and no floats", async () => {
    const ada = (await csv()).split("\r\n")[1] as string;
    expect(ada).toMatch(
      new RegExp(
        `^2026-11-07T10:05:00.000Z,2026-11,Ada Lovelace,0.050000,USDC,USDC,0.050000,,2026-11-0[0-9]T[0-9:.]+Z,USDC on Base,Base,${EVM},0.002400,0.002413,SUCCESS,yes,0.000530,${DEPOSIT},ih-ada,${NEAR_TX},${BASE_TX},https://basescan.org/tx/${BASE_TX},https://basescan.org/tx/${BASE_TX},[0-9a-f-]{36}$`,
      ),
    );
    expect(await csv()).toContain(",1.234567,");
  });

  it("neutralizes formulas and quotes per RFC 4180", async () => {
    const text = await csv();
    expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(text).toContain('"Bo ""the, quoted"" Li"');
  });

  it("filters by date, inclusive", async () => {
    const none = (await get(`/orgs/${orgId}/exports/payouts.csv?from=2026-11-08&to=2026-11-09`))
      .body;
    expect(none.split("\r\n")).toHaveLength(2);
  });

  it("is a downloadable file", async () => {
    const res = await get(`/orgs/${orgId}/exports/payouts.csv?from=2026-11-01&to=2026-11-30`);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
  });

  it.each(["", "?from=2026-11-07", "?from=2026-11-09&to=2026-11-07", "?from=nov&to=dec"])(
    "rejects %j",
    async (q) => {
      expect((await get(`/orgs/${orgId}/exports/payouts.csv${q}`)).statusCode).toBe(400);
    },
  );
});

describe("ledger", () => {
  it("is live only by default, with every hash, links and reconciliation state", async () => {
    const res = (await get(`/orgs/${orgId}/ledger`)).json();
    expect(res.items.every((i: { mode: string }) => i.mode === "live")).toBe(true);
    const ada = res.items.find(
      (i: { contractor?: { name: string } }) => i.contractor?.name === "Ada Lovelace",
    );
    expect(ada).toMatchObject({
      kind: "payout",
      status: "SUCCESS",
      amount: "0.050000",
      reconciled: true,
      refundedAmount: "0.000530",
      hashes: {
        intentHash: "ih-ada",
        depositAddress: DEPOSIT,
        nearTxHashes: [NEAR_TX],
        destinationTxHash: BASE_TX,
      },
      links: {
        intentsExplorer: `https://explorer.near-intents.org/transactions/${DEPOSIT}`,
        nearTxs: [`https://nearblocks.io/txns/${NEAR_TX}`],
        destinationTx: `https://basescan.org/tx/${BASE_TX}`,
      },
    });
    expect(ada.statusHistory.map((s: { status: string }) => s.status)).toEqual([
      "PLANNED",
      "SUCCESS",
    ]);
  });

  it("shows simulated records only when asked, always labelled", async () => {
    const sim = (await get(`/orgs/${orgId}/ledger?mode=simulated`)).json();
    expect(sim.items).toHaveLength(1);
    expect(sim.items[0]).toMatchObject({
      simulated: true,
      label: expect.stringContaining("SIMULATED"),
    });
  });

  it("filters by status, contractor and period", async () => {
    expect((await get(`/orgs/${orgId}/ledger?status=REFUNDED`)).json().items).toHaveLength(1);
    expect((await get(`/orgs/${orgId}/ledger?period=2026-10`)).json().items).toHaveLength(0);
  });

  it("paginates with a cursor, without repeats or gaps", async () => {
    const seen: string[] = [];
    let cursor = "";
    for (let i = 0; i < 10; i += 1) {
      const res = (
        await get(`/orgs/${orgId}/ledger?limit=1${cursor ? `&cursor=${cursor}` : ""}`)
      ).json();
      seen.push(...res.items.map((x: { id: string }) => x.id));
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    const all = (await get(`/orgs/${orgId}/ledger?limit=200`))
      .json()
      .items.map((x: { id: string }) => x.id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("rejects a bad cursor", async () => {
    expect((await get(`/orgs/${orgId}/ledger?cursor=garbage`)).statusCode).toBe(400);
  });
});

describe("payslip", () => {
  it("has everything for one payout", async () => {
    const res = (await get(`/orgs/${orgId}/pay-runs/${runId}/items/${items.ada}/payslip`)).json();
    expect(res).toMatchObject({
      contractor: { name: "Ada Lovelace" },
      period: "2026-11",
      amount: "0.050000",
      route: "USDC on Base",
      deliveryFee: "0.002400",
      totalFee: "0.002413",
      quoteAsOf: "2026-11-07T10:00:00.000Z",
      status: "SUCCESS",
      reconciled: true,
      mode: "live",
      simulated: false,
      links: { destinationTx: `https://basescan.org/tx/${BASE_TX}` },
    });
  });

  it("an unknown item gets 404", async () => {
    const res = await get(
      `/orgs/${orgId}/pay-runs/${runId}/items/00000000-0000-4000-8000-000000000000/payslip`,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe("roles", () => {
  it("an accountant reads everything; a viewer gets 403 on all of it", async () => {
    const accountant = await addMember(app, owner.cookies, orgId, "accountant");
    const viewer = await addMember(app, owner.cookies, orgId, "viewer");
    const urls = [
      `/orgs/${orgId}/ledger`,
      `/orgs/${orgId}/pay-runs/${runId}/items/${items.ada}/payslip`,
      `/orgs/${orgId}/exports/payouts.csv?from=2026-11-01&to=2026-11-30`,
      `/orgs/${orgId}/audit`,
    ];
    for (const url of urls) {
      expect((await get(url, accountant.cookies)).statusCode).toBe(200);
      expect((await get(url, viewer.cookies)).statusCode).toBe(403);
    }
  });
});

describe("audit view", () => {
  it("lists entries, filters by action and prefix, and paginates", async () => {
    const all = (await get(`/orgs/${orgId}/audit?limit=200`)).json();
    expect(all.items.map((a: { action: string }) => a.action)).toContain("org.create");
    const exact = (await get(`/orgs/${orgId}/audit?action=org.create`)).json();
    expect(exact.items.every((a: { action: string }) => a.action === "org.create")).toBe(true);
    const prefix = (await get(`/orgs/${orgId}/audit?action=member.*`)).json();
    expect(prefix.items.length).toBeGreaterThan(0);
    expect(prefix.items.every((a: { action: string }) => a.action.startsWith("member."))).toBe(
      true,
    );
  });

  it("never returns a secret, signature, token or signed payload", async () => {
    // A session and a payee approval first, so the log holds actions that involved secrets.
    const r = (
      await app.inject({
        method: "POST",
        url: `/orgs/${orgId}/treasury/session-request`,
        cookies: owner.cookies,
      })
    ).json();
    const sig = owner.wallet.sign(r.payload.message, r.payload.nonce, r.payload.recipient);
    await app.inject({
      method: "POST",
      url: `/orgs/${orgId}/treasury/session-request/${r.requestId}/complete`,
      cookies: owner.cookies,
      payload: {
        accountId: owner.wallet.accountId,
        publicKey: owner.wallet.publicKey,
        signature: sig,
      },
    });
    const body = (await get(`/orgs/${orgId}/audit?limit=200`)).body;
    expect(body).toContain("treasury.session_create");
    for (const secret of [
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      sig,
      Object.values(owner.cookies)[0] as string,
      RECIPIENT + "x",
    ]) {
      expect(body).not.toContain(secret);
    }
    expect(body).not.toMatch(/ed25519:|signature|accessToken|refreshToken|encrypted/i);
  });
});
