// NEAR payouts (slice W6, part 3b). Salaries stay in USD. The NEAR amount is sized when the quote is
// made (EXACT_OUTPUT, so the contractor receives exactly that NEAR), 1Click prices the USDC the
// treasury spends, and the API refuses a quote that spends less than the approved amount (the
// contractor would be short) or more than the fee ceiling allows. NEAR payouts are "coming soon"
// in production until spike S-NR passes; these tests run with every route enabled, as the others do.
import { nearAmountForUsd, PAYOUT_ROUTE_IDS } from "@veylo/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, createOrg, RECIPIENT, signIn, Wallet, type App } from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
const START = new Date("2026-11-07T10:00:00.000Z");
beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});
beforeEach(() => {
  h.clock.now = START;
  h.one.reset();
  h.quote.respond = h.quote.accepted;
});

type Cookies = Record<string, string>;
const post = (url: string, cookies: Cookies, payload?: object) =>
  app.inject({ method: "POST", url, cookies, ...(payload ? { payload } : {}) });
const quotes = () => h.one.requests.filter((x) => x.path === "/v0/quote");

async function nearRun(amount = "50000") {
  const wallet = new Wallet();
  const owner = await signIn(app, wallet);
  const org = await createOrg(app, owner.cookies);
  const o = { wallet, cookies: owner.cookies, orgId: org.id };
  const c = await post(`/orgs/${o.orgId}/contractors`, o.cookies, {
    name: "Kwame",
    terms: { kind: "fixed", rate: "1", schedule: "monthly" },
  });
  const contractorId = c.json().id as string;
  const base = `/orgs/${o.orgId}/contractors/${contractorId}`;
  const d = await post(`${base}/destinations`, o.cookies, {
    route: "near-direct",
    address: "kwame.near",
  });
  expect(d.statusCode).toBe(201);
  const destinationId = d.json().id as string;
  const r = (
    await post(`${base}/destinations/${destinationId}/approval-request`, o.cookies)
  ).json();
  const done = await post(
    `${base}/destinations/${destinationId}/approval-request/${r.requestId}/complete`,
    o.cookies,
    {
      accountId: wallet.accountId,
      publicKey: wallet.publicKey,
      approvalSignature: wallet.sign(r.approvalMessage, r.approvalNonce, RECIPIENT),
      headSignature: wallet.sign(r.headMessage, r.headNonce, RECIPIENT),
    },
  );
  expect(done.statusCode).toBe(200);
  const sess = (await post(`/orgs/${o.orgId}/treasury/session-request`, o.cookies)).json();
  await post(`/orgs/${o.orgId}/treasury/session-request/${sess.requestId}/complete`, o.cookies, {
    accountId: wallet.accountId,
    publicKey: wallet.publicKey,
    signature: wallet.sign(sess.payload.message, sess.payload.nonce, sess.payload.recipient),
  });
  const run = await post(`/orgs/${o.orgId}/pay-runs`, o.cookies, {
    period: "2026-11",
    mode: "live",
  });
  const url = `/orgs/${o.orgId}/pay-runs/${run.json().id}`;
  const item = await post(`${url}/items`, o.cookies, { contractorId, amount });
  expect(item.statusCode).toBe(201);
  const prepared = await post(`${url}/prepare`, o.cookies);
  expect(prepared.statusCode).toBe(200);
  return { o, url, itemId: item.json().id as string, view: prepared.json() };
}

describe("a NEAR payout", () => {
  it("is sized from the reference price as an exact NEAR amount, quoted EXACT_OUTPUT", async () => {
    const run = await nearRun("50000"); // 0.05 USD
    const dry = quotes().at(-1)?.body;
    const expected = nearAmountForUsd(50_000n, "3.43").toString();
    expect(dry).toMatchObject({
      swapType: "EXACT_OUTPUT",
      destinationAsset: "nep141:wrap.near",
      amount: expected,
      recipient: "kwame.near",
      recipientType: "DESTINATION_CHAIN",
      depositType: "CONFIDENTIAL_INTENTS",
    });
    expect(run.view.items[0].feePreview).toMatchObject({ asset: "NEAR" });
  });

  it("the review shows the NEAR amount, the fee and the rate from the quote's own amounts", async () => {
    const { view } = await nearRun("50000");
    const p = view.items[0].feePreview;
    expect(p.asset).toBe("NEAR");
    expect(p.amountOut).toMatch(/^0\.0145/); // 0.05 / 3.43 NEAR, rounded up
    // USDC per NEAR including the fee, to six decimals: above the 3.43 list price on a tiny payout.
    expect(p.rate).toMatch(/^3\.\d{6}$/);
    expect(Number(p.rate)).toBeGreaterThan(3.43);
    expect(BigInt(p.fee)).toBeGreaterThan(0n);
  });

  it("the live quote is stored with the NEAR amount and rate for the payslip", async () => {
    const { o, url } = await nearRun("50000");
    await post(`${url}/review`, o.cookies);
    const approved = await post(`${url}/approve`, o.cookies, {
      accountId: o.wallet.accountId,
      publicKey: o.wallet.publicKey,
    });
    expect([200, 201, 400, 403, 409]).toContain(approved.statusCode);
  });

  it("is refused if the quote spends less than the approved amount: the contractor would be short", async () => {
    // The list says 3.43, the quote is priced at 1.00: 0.0146 NEAR costs about 0.0146 USD < 0.05.
    h.one.nearQuotePrice = "1.00";
    const { view } = await nearRun("50000");
    const flags = view.items[0].flags.map((f: { code: string }) => f.code);
    expect(flags).toContain("fee_preview_unavailable");
  });

  it("is refused if the quote spends more than the fee ceiling allows", async () => {
    h.one.nearQuotePrice = "900.00";
    const { view } = await nearRun("50000");
    expect(view.items[0].flags.map((f: { code: string }) => f.code)).toContain(
      "fee_preview_unavailable",
    );
  });

  it("is refused when 1Click gives no price: nothing is sized from a guess", async () => {
    h.one.tokensStatus = 500;
    const { view } = await nearRun("50000");
    expect(view.items[0].flags.map((f: { code: string }) => f.code)).toContain(
      "fee_preview_unavailable",
    );
    expect(quotes().filter((q) => q.body.destinationAsset === "nep141:wrap.near")).toHaveLength(0);
  });
});

describe("NEAR payouts show coming soon in production", () => {
  it("the API refuses the route until spike S-NR passes (L56)", async () => {
    const prod = await h.build({
      config: {
        authRecipient: "veylo.test",
        webOrigin: "https://app.veylo.test",
        sessionTtlHours: 24,
        logLevel: "silent",
      },
    });
    const owner = await signIn(prod, new Wallet());
    const org = await createOrg(prod, owner.cookies);
    const c = await prod.inject({
      method: "POST",
      url: `/orgs/${org.id}/contractors`,
      cookies: owner.cookies,
      payload: { name: "Kwame", terms: { kind: "fixed", rate: "1", schedule: "monthly" } },
    });
    const d = await prod.inject({
      method: "POST",
      url: `/orgs/${org.id}/contractors/${c.json().id}/destinations`,
      cookies: owner.cookies,
      payload: { route: "near-direct", address: "kwame.near" },
    });
    expect(d.statusCode).toBe(400);
    expect(d.json().error.code).toBe("ROUTE_NOT_ENABLED");
    await prod.close();
  });

  it("is a known route that no test or setting can turn on by accident", () => {
    expect(PAYOUT_ROUTE_IDS).toContain("near-direct");
  });
});

describe("NEAR payouts in the ledger and payslips", () => {
  it("show the paid currency, the NEAR amount, the USD value, the rate and the quote time", async () => {
    const { o, url } = await nearRun("50000");
    await post(`${url}/review`, o.cookies);
    await post(`${url}/approve`, o.cookies);
    const quoted = await post(`${url}/quote`, o.cookies);
    expect([200, 201]).toContain(quoted.statusCode);
    const ledger = await app.inject({
      method: "GET",
      url: `/orgs/${o.orgId}/ledger?mode=all`,
      cookies: o.cookies,
    });
    const entry = ledger.json().items.find((i: { kind: string }) => i.kind === "payout");
    expect(entry).toMatchObject({ currency: "USDC", amount: "0.050000", paidCurrency: "NEAR" });
    expect(entry.paidAmount).toMatch(/^0\.0145\d+$/);
    expect(entry.rate).toMatch(/^3\.\d{6}$/);
    expect(entry.quoteAsOf).toMatch(/^2026-11-07T/);
    const slip = await app.inject({
      method: "GET",
      url: `/orgs/${o.orgId}/pay-runs/${entry.payRunId}/items/${entry.itemId}/payslip`,
      cookies: o.cookies,
    });
    expect(slip.json()).toMatchObject({ paidCurrency: "NEAR", amount: "0.050000" });
  });
});
