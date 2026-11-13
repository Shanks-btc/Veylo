import { PAYOUT_ROUTE_IDS } from "@veylo/core";
import { schema } from "@veylo/db";
import { eq, sql } from "drizzle-orm";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  createHarness,
  createOrg,
  QUOTE_KEY,
  signIn,
  type App,
} from "./test-support.js";

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
beforeEach(() => {
  h.quote.respond = h.quote.accepted;
  h.quote.requests.length = 0;
});

const EVM = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
const EVM_2 = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TERMS = { kind: "fixed", rate: "5000000000", schedule: "monthly" };

type Dest = Record<string, never> & {
  id: string;
  status: string;
  address: string;
  payable: boolean;
  payableReason: string;
  check: { status: string; reason: string | null };
  feePreview: Record<string, string> | null;
  warnings: { code: string }[];
  supersededAt: string | null;
};

async function setup() {
  const owner = await signIn(app);
  const org = await createOrg(app, owner.cookies);
  const res = await app.inject({
    method: "POST",
    url: `/orgs/${org.id}/contractors`,
    cookies: owner.cookies,
    payload: { name: "Ada", email: "ada@example.com", terms: TERMS },
  });
  expect(res.statusCode).toBe(201);
  const contractor = res.json() as { id: string };
  const base = `/orgs/${org.id}/contractors/${contractor.id}`;
  const addDest = (route: string, address: string) =>
    app.inject({
      method: "POST",
      url: `${base}/destinations`,
      cookies: owner.cookies,
      payload: { route, address },
    });
  const list = async () =>
    (
      await app.inject({ method: "GET", url: `${base}/destinations`, cookies: owner.cookies })
    ).json().destinations as Dest[];
  return { owner, org, contractor, base, addDest, list, cookies: owner.cookies };
}

describe("contractors", () => {
  it("creates and reads, keeping the rate as text", async () => {
    const { base, cookies } = await setup();
    const res = await app.inject({ method: "GET", url: base, cookies });
    expect(res.json()).toMatchObject({
      name: "Ada",
      email: "ada@example.com",
      terms: TERMS,
      status: "active",
      payoutMode: null,
    });
  });

  it("email is optional", async () => {
    const { org, cookies } = await setup();
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${org.id}/contractors`,
      cookies,
      payload: { name: "Bo", terms: TERMS },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().email).toBeNull();
  });

  it.each([
    ["a float rate", { kind: "fixed", rate: 1.5, schedule: "monthly" }],
    ["a decimal text rate", { kind: "fixed", rate: "1.5", schedule: "monthly" }],
    ["a zero rate", { kind: "fixed", rate: "0", schedule: "monthly" }],
    ["a rate over bigint", { kind: "fixed", rate: "9".repeat(20), schedule: "monthly" }],
    ["an unknown kind", { kind: "salary", rate: "1", schedule: "monthly" }],
    ["an unknown schedule", { kind: "fixed", rate: "1", schedule: "daily" }],
    ["an extra field", { kind: "fixed", rate: "1", schedule: "monthly", x: 1 }],
  ])("rejects terms with %s", async (_name, terms) => {
    const { org, cookies } = await setup();
    const res = await app.inject({
      method: "POST",
      url: `/orgs/${org.id}/contractors`,
      cookies,
      payload: { name: "X", terms },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists only this org's contractors", async () => {
    const { org, contractor, cookies } = await setup();
    await setup();
    const res = await app.inject({ method: "GET", url: `/orgs/${org.id}/contractors`, cookies });
    expect(res.json().contractors.map((c: { id: string }) => c.id)).toEqual([contractor.id]);
  });

  it("patches fields, and refuses status or an empty patch", async () => {
    const { base, cookies } = await setup();
    const patch = (payload: object) => app.inject({ method: "PATCH", url: base, cookies, payload });
    const ok = await patch({ name: "Ada L", email: null });
    expect(ok.json()).toMatchObject({ name: "Ada L", email: null });
    expect((await patch({ status: "archived" })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ address: EVM })).statusCode).toBe(400);
  });

  it("archive keeps the row, and blocks further writes", async () => {
    const { base, cookies, addDest } = await setup();
    const res = await app.inject({ method: "POST", url: `${base}/archive`, cookies });
    expect(res.json().status).toBe("archived");
    const read = await app.inject({ method: "GET", url: base, cookies });
    expect(read.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: `${base}/archive`, cookies });
    expect(again.json().error.code).toBe("CONTRACTOR_ARCHIVED");
    const patch = await app.inject({ method: "PATCH", url: base, cookies, payload: { name: "Z" } });
    expect(patch.statusCode).toBe(409);
    expect((await addDest("usdc-base", EVM)).statusCode).toBe(409);
  });

  it("the database refuses DELETE", async () => {
    const { contractor } = await setup();
    await expect(
      h.db.delete(schema.contractors).where(eq(schema.contractors.id, contractor.id)),
    ).rejects.toThrow();
  });
});

describe("roles", () => {
  it.each(["viewer", "accountant"] as const)("a %s reads but can't write", async (role) => {
    const { org, base, cookies, addDest } = await setup();
    await addDest("usdc-base", EVM);
    const [dest] = await (await setup()).list();
    void dest;
    const member = await addMember(app, cookies, org.id, role);
    const c = member.cookies;
    for (const url of [`/orgs/${org.id}/contractors`, base, `${base}/destinations`]) {
      expect((await app.inject({ method: "GET", url, cookies: c })).statusCode).toBe(200);
    }
    const writes = await Promise.all([
      app.inject({
        method: "POST",
        url: `/orgs/${org.id}/contractors`,
        cookies: c,
        payload: { name: "X", terms: TERMS },
      }),
      app.inject({ method: "PATCH", url: base, cookies: c, payload: { name: "X" } }),
      app.inject({ method: "POST", url: `${base}/archive`, cookies: c }),
      app.inject({
        method: "POST",
        url: `${base}/destinations`,
        cookies: c,
        payload: { route: "usdc-base", address: EVM },
      }),
      app.inject({
        method: "POST",
        url: `${base}/destinations/00000000-0000-4000-8000-000000000000/recheck`,
        cookies: c,
      }),
    ]);
    expect(writes.map((w) => w.statusCode)).toEqual([403, 403, 403, 403, 403]);
  });
});

describe("format validation runs before any quote", () => {
  it.each([
    ["usdc-base", "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"],
    ["usdc-base", `0x${"0".repeat(40)}`],
    ["usdc-arbitrum", SOL],
    ["usdc-solana", EVM],
    ["usdc-solana", "1".repeat(32)],
    ["usdc-near-confidential", "Not.Valid"],
  ])("%s rejects %s", async (route, address) => {
    const { addDest, list } = await setup();
    const res = await addDest(route, address);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("ADDRESS_INVALID");
    expect(h.quote.requests).toHaveLength(0);
    expect(await list()).toEqual([]);
  });

  it("refuses an unsupported route such as Tron", async () => {
    const { addDest } = await setup();
    expect((await addDest("usdc-tron", "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb")).statusCode).toBe(400);
  });

  it("stores the checksum form of a lowercase address", async () => {
    const { addDest } = await setup();
    const res = await addDest("usdc-base", EVM.toLowerCase());
    expect(res.json().address).toBe(EVM);
  });
});

describe("the acceptance check", () => {
  it("Direct: sends the agreed dry quote, refunding to the org's treasury", async () => {
    const { addDest, owner } = await setup();
    await addDest("usdc-base", EVM);
    expect(h.quote.requests[0]).toMatchObject({
      dry: true,
      swapType: "EXACT_OUTPUT",
      amount: "1000000",
      depositType: "CONFIDENTIAL_INTENTS",
      recipientType: "DESTINATION_CHAIN",
      recipient: EVM,
      refundTo: owner.wallet.accountId,
      refundType: "CONFIDENTIAL_INTENTS",
    });
  });

  it("Private: sends CONFIDENTIAL_INTENTS with the NEAR account", async () => {
    const { addDest } = await setup();
    await addDest("usdc-near-confidential", "ada.near");
    expect(h.quote.requests[0]).toMatchObject({
      recipient: "ada.near",
      recipientType: "CONFIDENTIAL_INTENTS",
    });
  });

  it("accepted: active, with a fee preview, and honestly not payable", async () => {
    const { addDest } = await setup();
    const res = await addDest("usdc-base", EVM);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: "active",
      check: { status: "accepted", reason: null },
      feePreview: {
        amountOut: "100000",
        amountIn: "105882",
        minAmountIn: "104823",
        impliedFee: "4823",
        impliedFeeBps: "482.30",
        deliveryFee: "4800",
      },
      payable: false,
      payableReason: "owner_approval_required",
    });
  });

  it("rejected: stored with 1Click's reason, leaving the current destination in place", async () => {
    const { addDest, list } = await setup();
    const good = (await addDest("usdc-base", EVM)).json() as Dest;
    h.quote.respond = h.quote.rejected;
    const res = await addDest("usdc-base", EVM_2);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: "candidate",
      check: { status: "rejected", reason: "recipient is not valid" },
      feePreview: null,
      payable: false,
    });
    const current = (await list()).find((d) => d.id === good.id);
    expect(current?.status).toBe("active");
  });

  it.each([
    ["a network failure", () => Promise.reject(new Error("down"))],
    ["a rate limit", () => Promise.resolve(new Response("{}", { status: 429 }))],
  ])("check_failed on %s: stored as retryable", async (_name, respond) => {
    const { addDest } = await setup();
    h.quote.respond = respond;
    const res = await addDest("usdc-base", EVM);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "candidate", check: { status: "check_failed" } });
  });

  it("an inconsistent quote is check_failed, never accepted", async () => {
    const { addDest } = await setup();
    h.quote.respond = () => {
      const body = {
        quote: { amountIn: "1", minAmountIn: "2", amountOut: "1", withdrawFee: "0" },
        quoteRequest: { dry: true },
      };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 201 }));
    };
    expect((await addDest("usdc-base", EVM)).json().check.status).toBe("check_failed");
  });
});

describe("route_unavailable (L27)", () => {
  const pair = () =>
    Promise.resolve(
      new Response(JSON.stringify({ message: "Quoting for this pair is not available" }), {
        status: 400,
      }),
    );

  it("is distinct from rejected, keeps the reason, and displaces nothing", async () => {
    const { addDest, list } = await setup();
    const good = (await addDest("usdc-base", EVM)).json() as Dest;
    h.quote.respond = pair;
    const res = await addDest("usdc-arbitrum", EVM_2);
    expect(res.json()).toMatchObject({
      status: "candidate",
      check: { status: "route_unavailable", reason: "Quoting for this pair is not available" },
    });
    expect((await list()).find((d) => d.id === good.id)?.status).toBe("active");
  });

  it("can be rechecked, and activates once the route returns", async () => {
    const { addDest, base, cookies } = await setup();
    h.quote.respond = pair;
    const dest = (await addDest("usdc-base", EVM)).json() as Dest;
    const recheck = () =>
      app.inject({ method: "POST", url: `${base}/destinations/${dest.id}/recheck`, cookies });
    expect((await recheck()).json().check.status).toBe("route_unavailable");
    h.quote.respond = h.quote.accepted;
    expect((await recheck()).json()).toMatchObject({
      status: "active",
      check: { status: "accepted" },
    });
  });
});

describe("entered_by and contractor_confirmed_at (L27)", () => {
  it("are surfaced, all owner for now", async () => {
    const { addDest } = await setup();
    expect((await addDest("usdc-base", EVM)).json()).toMatchObject({
      enteredBy: "owner",
      contractorConfirmedAt: null,
    });
  });
});

describe("recheck", () => {
  async function failed() {
    const s = await setup();
    h.quote.respond = () => Promise.reject(new Error("down"));
    const dest = (await s.addDest("usdc-base", EVM)).json() as Dest;
    h.quote.respond = h.quote.accepted;
    const recheck = (id = dest.id) =>
      app.inject({
        method: "POST",
        url: `${s.base}/destinations/${id}/recheck`,
        cookies: s.cookies,
      });
    return { ...s, dest, recheck };
  }

  it("a retry that succeeds activates the destination", async () => {
    const { recheck } = await failed();
    const res = await recheck();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "active",
      check: { status: "accepted", reason: null },
      payable: false,
    });
  });

  it("a retry that fails again stays retryable", async () => {
    const { recheck } = await failed();
    h.quote.respond = () => Promise.reject(new Error("down"));
    expect((await recheck()).json().check.status).toBe("check_failed");
    h.quote.respond = h.quote.accepted;
    expect((await recheck()).statusCode).toBe(200);
  });

  it("a retry 1Click rejects is final", async () => {
    const { recheck } = await failed();
    h.quote.respond = h.quote.rejected;
    expect((await recheck()).json().check.status).toBe("rejected");
    expect((await recheck()).json().error.code).toBe("NOT_RETRYABLE");
  });

  it("refuses an accepted destination, with no quote", async () => {
    const { addDest, base, cookies } = await setup();
    const dest = (await addDest("usdc-base", EVM)).json() as Dest;
    h.quote.requests.length = 0;
    const res = await app.inject({
      method: "POST",
      url: `${base}/destinations/${dest.id}/recheck`,
      cookies,
    });
    expect(res.statusCode).toBe(409);
    expect(h.quote.requests).toHaveLength(0);
  });

  it("a failed candidate overtaken by an accepted change can't come back", async () => {
    const { addDest, recheck, list, dest } = await failed();
    await addDest("usdc-base", EVM_2);
    expect((await list()).find((d) => d.id === dest.id)?.status).toBe("superseded");
    expect((await recheck()).statusCode).toBe(409);
  });

  it("an unknown destination gets 404", async () => {
    const { recheck } = await failed();
    expect((await recheck("00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
  });
});

describe("addresses are never edited (L25)", () => {
  it("a change makes a new row, and the old one is superseded with a timestamp", async () => {
    const { addDest, list } = await setup();
    const first = (await addDest("usdc-base", EVM)).json() as Dest;
    const second = (await addDest("usdc-base", EVM_2)).json() as Dest;
    expect(second.id).not.toBe(first.id);
    const rows = await list();
    const old = rows.find((d) => d.id === first.id);
    expect(old).toMatchObject({ status: "superseded", address: EVM });
    expect(old?.supersededAt).toBe(h.clock.now.toISOString());
    expect(rows.find((d) => d.id === second.id)?.status).toBe("active");
  });

  it("no route can patch a destination", async () => {
    const { addDest, base, cookies } = await setup();
    const dest = (await addDest("usdc-base", EVM)).json() as Dest;
    for (const method of ["PATCH", "PUT", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: `${base}/destinations/${dest.id}`,
        cookies,
        ...(method === "DELETE" ? {} : { payload: { address: EVM_2 } }),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it.each([
    ["address", { address: EVM_2 }],
    ["route", { route: "usdc-arbitrum" }],
    ["chain", { chain: "arb" }],
    ["asset_id", { assetId: "other" }],
    ["payout_mode", { payoutMode: "private" as const }],
  ])("the database refuses changing %s", async (_name, change) => {
    const { addDest } = await setup();
    const dest = (await addDest("usdc-base", EVM)).json() as Dest;
    await expect(
      h.db
        .update(schema.payoutDestinations)
        .set(change)
        .where(eq(schema.payoutDestinations.id, dest.id)),
    ).rejects.toThrow();
  });

  it("the database refuses DELETE and TRUNCATE", async () => {
    const { addDest } = await setup();
    const dest = (await addDest("usdc-base", EVM)).json() as Dest;
    await expect(
      h.db.delete(schema.payoutDestinations).where(eq(schema.payoutDestinations.id, dest.id)),
    ).rejects.toThrow();
    await expect(h.db.execute(sql`TRUNCATE payout_destinations CASCADE`)).rejects.toThrow();
  });

  it("the database refuses reviving a superseded destination", async () => {
    const { addDest, list } = await setup();
    const first = (await addDest("usdc-base", EVM)).json() as Dest;
    await addDest("usdc-arbitrum", EVM);
    await expect(
      h.db
        .update(schema.payoutDestinations)
        .set({ status: "candidate", supersededAt: null })
        .where(eq(schema.payoutDestinations.id, first.id)),
    ).rejects.toThrow();
    expect((await list()).find((d) => d.id === first.id)?.status).toBe("superseded");
  });
});

describe("one active payout mode (rule 8)", () => {
  it("switching mode supersedes the old destination and updates the contractor", async () => {
    const { addDest, list, base, cookies } = await setup();
    const direct = (await addDest("usdc-base", EVM)).json() as Dest;
    const read = () => app.inject({ method: "GET", url: base, cookies });
    expect((await read()).json().payoutMode).toBe("direct");
    const priv = (await addDest("usdc-near-confidential", "ada.near")).json() as Dest;
    expect((await read()).json().payoutMode).toBe("private");
    const rows = await list();
    expect(rows.find((d) => d.id === direct.id)?.status).toBe("superseded");
    expect(rows.find((d) => d.id === priv.id)?.status).toBe("active");
    expect(rows.filter((d) => d.status === "active")).toHaveLength(1);
  });

  it("a rejected switch changes nothing", async () => {
    const { addDest, base, cookies } = await setup();
    await addDest("usdc-base", EVM);
    h.quote.respond = h.quote.rejected;
    await addDest("usdc-near-confidential", "ada.near");
    const res = await app.inject({ method: "GET", url: base, cookies });
    expect(res.json().payoutMode).toBe("direct");
  });

  it("the database refuses a second active destination", async () => {
    const { addDest, contractor, org } = await setup();
    await addDest("usdc-base", EVM);
    await expect(
      h.db.insert(schema.payoutDestinations).values({
        orgId: org.id,
        contractorId: contractor.id,
        route: "usdc-arbitrum",
        chain: "arb",
        assetId: "a",
        payoutMode: "direct",
        address: EVM,
        status: "active",
        checkStatus: "accepted",
      }),
    ).rejects.toThrow();
  });

  it("the database refuses an active destination that wasn't accepted", async () => {
    const { contractor, org } = await setup();
    await expect(
      h.db.insert(schema.payoutDestinations).values({
        orgId: org.id,
        contractorId: contractor.id,
        route: "usdc-base",
        chain: "base",
        assetId: "a",
        payoutMode: "direct",
        address: EVM,
        status: "active",
        checkStatus: "rejected",
      }),
    ).rejects.toThrow();
  });
});

describe("address hygiene in responses (rule 8)", () => {
  const flag = (id: string) =>
    h.db
      .update(schema.payoutDestinations)
      .set({ receivedPublicPayout: true })
      .where(eq(schema.payoutDestinations.id, id));

  it("warns on switching to Private with a publicly paid address on file", async () => {
    const { addDest, list } = await setup();
    const direct = (await addDest("usdc-base", EVM)).json() as Dest;
    await flag(direct.id);
    const priv = (await addDest("usdc-near-confidential", "ada.near")).json() as Dest;
    expect(priv.warnings).toMatchObject([
      { code: "SWITCH_TO_PRIVATE_WITH_PUBLIC_ADDRESS", address: EVM },
    ]);
    expect((await list()).every((d) => d.warnings.length === 1)).toBe(true);
  });

  it("is silent with no publicly paid address", async () => {
    const { addDest } = await setup();
    await addDest("usdc-base", EVM);
    const priv = (await addDest("usdc-near-confidential", "ada.near")).json() as Dest;
    expect(priv.warnings).toEqual([]);
  });
});

describe("audit log", () => {
  it("records contractor and destination changes, with no address or key", async () => {
    const { org, base, cookies, addDest } = await setup();
    await app.inject({ method: "PATCH", url: base, cookies, payload: { name: "B" } });
    h.quote.respond = () => Promise.reject(new Error("down"));
    const failed = (await addDest("usdc-arbitrum", EVM)).json() as Dest;
    h.quote.respond = h.quote.accepted;
    await app.inject({ method: "POST", url: `${base}/destinations/${failed.id}/recheck`, cookies });
    await addDest("usdc-base", EVM_2);
    await app.inject({ method: "POST", url: `${base}/archive`, cookies });
    const rows = await h.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, org.id));
    expect(rows.map((r) => r.action).sort()).toEqual([
      "contractor.archive",
      "contractor.create",
      "contractor.update",
      "destination.create",
      "destination.create",
      "destination.recheck",
      "destination.supersede",
      "org.create",
    ]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(EVM_2);
    expect(text).not.toContain(QUOTE_KEY);
  });
});

describe("no secrets", () => {
  it("the partner key reaches 1Click's header but no log or response", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logged = await h.build({
      logStream: stream,
      config: {
        // Tests keep every payout route covered (L46).
        enabledPayoutRoutes: PAYOUT_ROUTE_IDS,
        authRecipient: "veylo.test",
        webOrigin: "https://app.veylo.test",
        sessionTtlHours: 24,
        logLevel: "trace",
      },
    });
    const owner = await signIn(logged);
    const org = await createOrg(logged, owner.cookies);
    const created = await logged.inject({
      method: "POST",
      url: `/orgs/${org.id}/contractors`,
      cookies: owner.cookies,
      payload: { name: "Ada", terms: TERMS },
    });
    const res = await logged.inject({
      method: "POST",
      url: `/orgs/${org.id}/contractors/${created.json().id}/destinations`,
      cookies: owner.cookies,
      payload: { route: "usdc-base", address: EVM },
    });
    expect(h.quote.headers.at(-1)?.["x-api-key"]).toBe(QUOTE_KEY);
    expect(res.body).not.toContain(QUOTE_KEY);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join("")).not.toContain(QUOTE_KEY);
    await logged.close();
  });
});
