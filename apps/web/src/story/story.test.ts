// `pnpm demo` (slice W5, C4): the whole story in one run, with no keys and no money. The API runs
// in-process on its test database with stand-ins for NEAR Intents and NEAR RPC; wallets are
// throwaway keys. The browser checks run on a real recorded NEAR Intents quote, and the privacy
// proof reads recorded NEAR RPC answers. Each numbered check below is printed by the runner, and
// any failure makes `pnpm demo` exit non-zero.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { estimateText, nearAmountForUsd } from "@veylo/core";
import { listOutboxFor, schema } from "@veylo/db";
import { verifyNep413 } from "@veylo/intents";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiClient } from "../api/client.js";
import { createDemoWorld } from "../demo/world.js";
import { checkFundingQuote } from "../gates/funding.js";
import { runGates } from "../gates/index.js";
import { checkSessionRequest } from "../gates/session.js";
import { createEmbeddedWallet, type Prompt } from "../../bridge/embedded/flow.js";
import { keyFromPhrase } from "../../bridge/embedded/derive.js";
import { memoryStore } from "../../bridge/embedded/store.js";
import { PrfUnsupported } from "../../bridge/embedded/webauthn.js";
import { checkProofCase } from "../proof/check.js";
import { PROOF_CASES } from "../proof/cases.js";
import { canSign, checklist } from "../signing/pay-run.js";
import { buildStatement, payslipPdf } from "../reports/documents.js";
import { pdfText } from "../reports/pdf.js";
import { createScheduler } from "../../../api/src/scheduler.js";
import { createSettlement } from "../../../api/src/settlement.js";
import {
  addMember,
  createHarness,
  createOrg,
  RECIPIENT,
  sessionCookie,
  signIn,
  Wallet,
  type App,
} from "../../../api/src/test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
let app: App;
let jobs: ReturnType<typeof createSettlement>;
const quiet = { info() {}, warn() {}, error() {} };
const START = new Date("2026-11-07T10:00:00.000Z");

type Cookies = Record<string, string>;
const post = (url: string, cookies: Cookies, payload?: object) =>
  app.inject({ method: "POST", url, cookies, ...(payload ? { payload } : {}) });
const get = (url: string, cookies: Cookies) => app.inject({ method: "GET", url, cookies });

// State shared by the numbered checks, in order.
const s = {} as {
  wallet: Wallet;
  cookies: Cookies;
  orgId: string;
  base: string;
  contractorId: string;
  destinationId: string;
  runUrl: string;
  itemUrl: string;
  itemId: string;
  payRunId: string;
  /** The contractor who joined in check 13. */
  ada: Awaited<ReturnType<typeof signIn>>;
};

beforeAll(async () => {
  h = await createHarness();
  app = await h.build();
  h.clock.now = START;
  jobs = createSettlement({
    db: h.db,
    clock: () => h.clock.now,
    oneclickTreasury: h.treasuryClient,
    secrets: h.secrets,
    intents: h.intentsReader,
    rpc: h.rpc,
    config: {} as never,
  } as never);
  for (const a of ["ada-l.near", "grace-h.near", "ada-new.near"]) h.chain.set(a, new Map());
});
afterAll(async () => {
  await app.close();
  await h.client.close();
});

describe("the Veylo story", () => {
  it("1. Fund: the owner signs in, opens a treasury and asks for a funding quote", async () => {
    s.wallet = new Wallet();
    const owner = await signIn(app, s.wallet);
    s.cookies = owner.cookies;
    s.orgId = (await createOrg(app, s.cookies, "Northwind Studio (demo)")).id;
    const session = (await post(`/orgs/${s.orgId}/treasury/session-request`, s.cookies)).json();
    await post(
      `/orgs/${s.orgId}/treasury/session-request/${session.requestId}/complete`,
      s.cookies,
      {
        accountId: s.wallet.accountId,
        publicKey: s.wallet.publicKey,
        signature: s.wallet.sign(
          session.payload.message,
          session.payload.nonce,
          session.payload.recipient,
        ),
      },
    );
    const quote = await post(`/orgs/${s.orgId}/treasury/funding-quote`, s.cookies, {
      originRoute: "usdt-bsc",
      amount: "2000000000000000000",
      refundAddress: "0xAf780910c0E7D41430D4615A437676a87a332C8C",
    });
    expect(quote.statusCode).toBe(201);
    expect(quote.json()).toMatchObject({ depositAddress: expect.any(String) });
    const balances = (await get(`/orgs/${s.orgId}/treasury/balances`, s.cookies)).json();
    expect(balances.treasuryAccountId).toBe(s.wallet.accountId);
  });

  it("2. Add a contractor with a private NEAR address", async () => {
    const c = await post(`/orgs/${s.orgId}/contractors`, s.cookies, {
      name: "Ada Lovelace",
      terms: { kind: "fixed", rate: "50000", schedule: "monthly" },
    });
    expect(c.statusCode).toBe(201);
    s.contractorId = c.json().id;
    s.base = `/orgs/${s.orgId}/contractors/${s.contractorId}`;
    const d = await post(`${s.base}/destinations`, s.cookies, {
      route: "usdc-near-confidential",
      address: "ada-l.near",
    });
    expect(d.statusCode).toBe(201);
    s.destinationId = d.json().id;
    expect(d.json()).toMatchObject({ payable: false, payableReason: "owner_approval_required" });
  });

  it("3. Approve the address with the treasury wallet: now Ada is payable", async () => {
    const r = (
      await post(`${s.base}/destinations/${s.destinationId}/approval-request`, s.cookies)
    ).json();
    const res = await post(
      `${s.base}/destinations/${s.destinationId}/approval-request/${r.requestId}/complete`,
      s.cookies,
      {
        accountId: s.wallet.accountId,
        publicKey: s.wallet.publicKey,
        approvalSignature: s.wallet.sign(r.approvalMessage, r.approvalNonce, RECIPIENT),
        headSignature: s.wallet.sign(r.headMessage, r.headNonce, RECIPIENT),
      },
    );
    expect(res.statusCode).toBe(200);
    const dest = (await get(`${s.base}/destinations`, s.cookies)).json();
    expect(dest.destinations[0]).toMatchObject({ payable: true });
  });

  it("4. Review the pay run: priced, approved and quoted", async () => {
    const run = (
      await post(`/orgs/${s.orgId}/pay-runs`, s.cookies, { period: "2026-11", mode: "live" })
    ).json();
    s.payRunId = run.id;
    s.runUrl = `/orgs/${s.orgId}/pay-runs/${run.id}`;
    s.itemId = (
      await post(`${s.runUrl}/items`, s.cookies, { contractorId: s.contractorId, amount: "50000" })
    ).json().id;
    s.itemUrl = `${s.runUrl}/items/${s.itemId}`;
    expect((await post(`${s.runUrl}/prepare`, s.cookies)).statusCode).toBe(200);
    expect((await post(`${s.runUrl}/approve`, s.cookies)).statusCode).toBe(200);
    expect((await post(`${s.runUrl}/quote`, s.cookies)).json().status).toBe("Signing");
  });

  it("5. The browser checks pass on a real recorded NEAR Intents quote", async () => {
    const w = createDemoWorld();
    const report = await checkDemo(w);
    expect(report.items[0]?.gates.map((g) => g.gate + ":" + g.passed)).toEqual([
      "A:true",
      "deadline:true",
      "B:true",
      "B2:true",
      "C:true",
    ]);
    expect(report.allPassed).toBe(true);
    expect(canSign({ report, checking: false, signing: false, expired: false })).toBe(true);
  });

  it("6. A payout redirected to an attacker is refused, and approving stays locked", async () => {
    const w = createDemoWorld();
    w.setTampered(true);
    const report = await checkDemo(w);
    expect(report.allPassed).toBe(false);
    const failed = checklist(report)
      .filter((c) => c.state === "fail")
      .map((c) => c.id);
    expect(failed).toEqual(expect.arrayContaining(["A", "B"]));
    expect(canSign({ report, checking: false, signing: false, expired: false })).toBe(false);
  });

  it("7. Approve in the wallet: a first payout needs the owner's tick, then it settles", async () => {
    const early = await post(`${s.itemUrl}/sign-request`, s.cookies);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("ACKNOWLEDGEMENT_REQUIRED");
    expect((await post(`${s.itemUrl}/acknowledge`, s.cookies)).statusCode).toBe(200);
    const r = (await post(`${s.itemUrl}/sign-request`, s.cookies)).json();
    const done = await post(`${s.itemUrl}/sign-request/${r.requestId}/complete`, s.cookies, {
      accountId: s.wallet.accountId,
      publicKey: s.wallet.publicKey,
      signature: s.wallet.sign(r.payload.message, r.payload.nonce, r.payload.recipient),
    });
    expect(done.json()).toMatchObject({ status: "SUBMITTED" });
    const [a] = await h.db
      .select()
      .from(schema.payoutAttempts)
      .where(eq(schema.payoutAttempts.lineItemId, s.itemId));
    h.one.statusByDeposit.set(a!.depositAddress!, ["PROCESSING", "SUCCESS"]);
    await jobs.pollPayoutStatus(quiet);
    await jobs.pollPayoutStatus(quiet);
    const settled = (await get(s.runUrl, s.cookies)).json();
    expect(settled.items[0].attempt.status).toBe("SUCCESS");
  });

  it("8. The payslip and the CSV: a private payout says 'confidential', with its verify link", async () => {
    const slip = (await get(`${s.runUrl}/items/${s.itemId}/payslip`, s.cookies)).json();
    expect(slip).toMatchObject({ status: "SUCCESS", currency: "USDC" });
    const csv = (
      await get(`/orgs/${s.orgId}/exports/payouts.csv?from=2026-11-01&to=2026-11-30`, s.cookies)
    ).body;
    const [header, row] = csv.split("\r\n");
    expect(header).toContain("transaction link,payslip ID");
    expect(row).toContain(",confidential,");
    expect(row).toContain(s.itemId);
    const pdf = payslipPdf({
      company: "Northwind Studio (demo)",
      contractorName: "Ada Lovelace",
      itemId: s.itemId,
      routeId: "usdc-near-confidential",
      payslip: slip,
      appOrigin: "https://app.veylo.test",
    });
    expect(pdfText(pdf)).toContain(`https://app.veylo.test/verify?payout=${s.itemId}`);
    expect(pdfText(pdf)).toContain("Proof: confidential");
    const ledger = (await get(`/orgs/${s.orgId}/ledger`, s.cookies)).json();
    const statement = buildStatement(ledger.items, "2026-11");
    expect(statement).toMatchObject({ paidCount: 1 });
  });

  it("9. Privacy proof (recorded mainnet answers): the direct payout can be followed, the private one can't", async () => {
    const byHash = new Map(
      [
        "c2-12CP8DF7",
        "c2-2M4rSw8w",
        "c2-7Mm6ctWX",
        "c2-8rWKiads",
        "t5b-4cSR3khu",
        "t5b-NYxGcFad",
      ].map((n) => {
        const f = JSON.parse(
          readFileSync(new URL(`../proof/fixtures/rpc-${n}.json`, import.meta.url), "utf8"),
        );
        return [f.transaction.hash as string, f] as const;
      }),
    );
    const rpc = { tx: async (hash: string) => byHash.get(hash) };
    const [direct, priv] = await Promise.all(
      PROOF_CASES.map((c) => checkProofCase(c, rpc as never, () => START)),
    );
    expect(direct).toMatchObject({ status: "checked", linked: true });
    expect(priv).toMatchObject({ status: "checked", linked: false });
  });

  it("10. Recurring payroll: a draft appears three days before payday and nothing is quoted", async () => {
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/orgs/${s.orgId}/payroll-schedule`,
          cookies: s.cookies,
          payload: { kind: "monthly", dayOfMonth: 15, timeZone: "UTC" },
        })
      ).statusCode,
    ).toBe(200);
    h.clock.now = new Date("2026-12-12T09:00:00.000Z");
    const before = h.one.requests.length + h.quote.requests.length;
    expect(await createScheduler({ db: h.db, clock: () => h.clock.now }).prepareDue(quiet)).toEqual(
      { created: 1 },
    );
    expect(await createScheduler({ db: h.db, clock: () => h.clock.now }).prepareDue(quiet)).toEqual(
      { created: 0 },
    );
    expect(h.one.requests.length + h.quote.requests.length).toBe(before);
    h.clock.now = START;
  });

  it("11. Roles: a preparer drafts but can't ask for a payee approval", async () => {
    const prep = await addMember(app, s.cookies, s.orgId, "preparer");
    const draft = await post(`/orgs/${s.orgId}/pay-runs`, prep.cookies, {
      period: "2027-01",
      mode: "live",
    });
    expect(draft.statusCode).toBe(201);
    const approval = await post(
      `${s.base}/destinations/${s.destinationId}/approval-request`,
      prep.cookies,
    );
    expect(approval.statusCode).toBe(403);
  });

  it("12. CSV import: a bad row is shown and nothing is saved; a good file is saved, pending approval", async () => {
    const send = (csv: string, save: boolean) =>
      post(`/orgs/${s.orgId}/contractors/import`, s.cookies, { csv, save });
    const bad = (
      await send(
        "name,email,route,near_account\r\nGrace,,private,grace-h.near\r\nGhost,,private,ghost.near",
        true,
      )
    ).json();
    expect(bad).toMatchObject({ saved: false, created: 0 });
    expect(bad.rows.map((r: { ok: boolean }) => r.ok)).toEqual([true, false]);
    const good = (
      await send("name,email,route,near_account\r\nGrace Hopper,,private,grace-h.near", true)
    ).json();
    expect(good).toMatchObject({ saved: true, created: 1 });
  });

  it("13. Contractor portal: an invite works once; an address change waits 24 hours", async () => {
    const invite = (await post(`${s.base}/invites`, s.cookies)).json();
    const ada = await signIn(app);
    s.ada = ada;
    expect(
      (await post("/portal/invites/accept", ada.cookies, { token: invite.token })).statusCode,
    ).toBe(200);
    expect(
      (await post("/portal/invites/accept", ada.cookies, { token: invite.token })).statusCode,
    ).toBe(400);
    const change = (
      await post(`/portal/contractors/${s.contractorId}/address-change`, ada.cookies, {
        route: "usdc-near-confidential",
        address: "ada-new.near",
      })
    ).json();
    const early = await post(`${s.base}/address-changes/${change.id}/apply`, s.cookies);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("COOLING_PERIOD");
    const [pending] = await h.db
      .select()
      .from(schema.addressChangeRequests)
      .where(and(eq(schema.addressChangeRequests.contractorId, s.contractorId)));
    expect(pending?.appliedAt).toBeNull();
  });

  it("14. Email account: sign up, confirm by the emailed link, sign in; no wallet, no signing power", async () => {
    const email = `grace-${randomBytes(4).toString("hex")}@example.com`;
    const password = "correct horse battery staple 42";
    const up = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password },
    });
    expect(up.statusCode).toBe(201);
    const token =
      /token=([A-Za-z0-9_-]+)/.exec((await listOutboxFor(h.db, email))[0]?.body ?? "")?.[1] ?? "";
    expect(
      (await app.inject({ method: "POST", url: "/auth/verify-email", payload: { token } }))
        .statusCode,
    ).toBe(200);
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    const cookies = sessionCookie(login);
    expect((await get("/me", cookies)).json().user).toMatchObject({
      email,
      emailVerified: true,
      nearAccountId: null,
    });
    // An email can't be a treasury: making an organisation needs a linked wallet.
    const org = await post("/orgs", cookies, { name: "Email only" });
    expect(org.statusCode).toBe(409);
    expect(org.json().error.code).toBe("WALLET_REQUIRED");
  });

  it("15. Fund: USDC on NEAR first; NEAR and USDT wait for their live tests; the browser checks the quote's signature before a deposit address", async () => {
    const usdc = await post(`/orgs/${s.orgId}/treasury/funding-quote`, s.cookies, {
      originRoute: "usdc-near",
      amount: "1000000",
      refundAddress: s.wallet.accountId,
    });
    expect(usdc.statusCode).toBe(201);
    for (const route of ["near", "usdt-near"]) {
      const refused = await post(`/orgs/${s.orgId}/treasury/funding-quote`, s.cookies, {
        originRoute: route,
        amount: "1000000",
        refundAddress: s.wallet.accountId,
      });
      expect(refused.statusCode, `${route} is coming soon`).not.toBe(201);
    }
    // Gate F on a real quote signed by 1Click's real key: it passes, and a changed deposit address fails.
    const QUOTE = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/intents/src/fixtures/treasury-funding-live.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ).body;
    const served = {
      signedQuote: QUOTE,
      depositAddress: QUOTE.quote.depositAddress as string,
      amountOut: QUOTE.quote.amountOut as string,
    };
    const expected = {
      treasuryAccountId: QUOTE.quoteRequest.recipient as string,
      originAssetId: QUOTE.quoteRequest.originAsset as string,
      amount: QUOTE.quoteRequest.amount as string,
      refundAddress: QUOTE.quoteRequest.refundTo as string,
    };
    const now = new Date(Date.parse(QUOTE.timestamp) + 2 * 60_000);
    expect(checkFundingQuote({ served, expected, now }).ok).toBe(true);
    expect(
      checkFundingQuote({
        served: { ...served, depositAddress: "0x0000000000000000000000000000000000000bad" },
        expected,
        now,
      }).ok,
    ).toBe(false);
  });

  it("16. Local currency: an estimate beside the dollars, never part of an amount that moves", async () => {
    expect(estimateText(50_000_000n, "1550.250000", "NGN")).toMatch(/^≈ ₦77,512\.50$/);
    expect(estimateText(50_000_000n, undefined, "NGN")).toBeUndefined(); // no rate: the screen says so
    const set = await app.inject({
      method: "PATCH",
      url: s.base,
      cookies: s.cookies,
      payload: { displayCurrency: "NGN" },
    });
    expect(set.statusCode).toBe(200);
    const after = (await get(s.base, s.cookies)).json();
    expect(after).toMatchObject({ displayCurrency: "NGN", terms: { rate: "50000" } }); // the pay terms are untouched
    expect((await get("/fx", s.cookies)).json()).toEqual({ available: false }); // unavailable is a normal answer
  });

  it("17. Contractor balance: read only after their own wallet signs an empty intent", async () => {
    const base = `/portal/contractors/${s.contractorId}`;
    expect((await get(`${base}/balance`, s.ada.cookies)).json()).toMatchObject({
      available: false,
      unavailable: "needs_session",
    });
    const req = (await post(`${base}/session-request`, s.ada.cookies)).json();
    // The browser refuses anything but an empty intent for the wallet's own account.
    const ok = checkSessionRequest(req.payload, {
      accountId: s.ada.wallet.accountId,
      now: h.clock.now,
    });
    expect(ok.ok).toBe(true);
    expect(
      checkSessionRequest(req.payload, { accountId: "someone-else.near", now: h.clock.now }).ok,
    ).toBe(false);
    const transfer = JSON.stringify({
      deadline: JSON.parse(req.payload.message).deadline,
      intents: [{ intent: "transfer", receiver_id: "thief.near", tokens: { x: "1" } }],
      signer_id: s.ada.wallet.accountId,
    });
    expect(
      checkSessionRequest(
        { ...req.payload, message: transfer },
        { accountId: s.ada.wallet.accountId, now: h.clock.now },
      ).ok,
    ).toBe(false);
    const done = await post(`${base}/session-request/${req.requestId}/complete`, s.ada.cookies, {
      accountId: s.ada.wallet.accountId,
      publicKey: s.ada.wallet.publicKey,
      signature: s.ada.wallet.sign(req.payload.message, req.payload.nonce, req.payload.recipient),
    });
    expect(done.statusCode).toBe(200);
    expect((await get(`${base}/balance`, s.ada.cookies)).json()).toMatchObject({ available: true });
  });

  it("18. Pay in NEAR: the salary stays in dollars, the NEAR amount is sized when the payout is quoted", async () => {
    const owner = new Wallet();
    const o = await signIn(app, owner);
    const org = (await createOrg(app, o.cookies, "NEAR payout demo")).id;
    h.chain.set("kwame.near", new Map());
    const c = (
      await post(`/orgs/${org}/contractors`, o.cookies, {
        name: "Kwame",
        terms: { kind: "fixed", rate: "1", schedule: "monthly" },
      })
    ).json();
    const base = `/orgs/${org}/contractors/${c.id}`;
    const d = (
      await post(`${base}/destinations`, o.cookies, { route: "near-direct", address: "kwame.near" })
    ).json();
    const r = (await post(`${base}/destinations/${d.id}/approval-request`, o.cookies)).json();
    await post(`${base}/destinations/${d.id}/approval-request/${r.requestId}/complete`, o.cookies, {
      accountId: owner.accountId,
      publicKey: owner.publicKey,
      approvalSignature: owner.sign(r.approvalMessage, r.approvalNonce, RECIPIENT),
      headSignature: owner.sign(r.headMessage, r.headNonce, RECIPIENT),
    });
    const sess = (await post(`/orgs/${org}/treasury/session-request`, o.cookies)).json();
    await post(`/orgs/${org}/treasury/session-request/${sess.requestId}/complete`, o.cookies, {
      accountId: owner.accountId,
      publicKey: owner.publicKey,
      signature: owner.sign(sess.payload.message, sess.payload.nonce, sess.payload.recipient),
    });
    const run = (
      await post(`/orgs/${org}/pay-runs`, o.cookies, { period: "2027-02", mode: "live" })
    ).json();
    const url = `/orgs/${org}/pay-runs/${run.id}`;
    await post(`${url}/items`, o.cookies, { contractorId: c.id, amount: "50000" }); // 0.05 USD
    const view = (await post(`${url}/prepare`, o.cookies)).json();
    const quote = h.one.requests.filter((x) => x.path === "/v0/quote").at(-1)?.body;
    expect(quote).toMatchObject({
      swapType: "EXACT_OUTPUT",
      destinationAsset: "nep141:wrap.near",
      amount: nearAmountForUsd(50_000n, "3.43").toString(),
    });
    expect(view.items[0].feePreview).toMatchObject({ asset: "NEAR" });
  });

  it("19. Veylo wallet: made in the browser, phrase confirmed, signs bytes the app verifies like any wallet", async () => {
    const words: string[] = [];
    const prompt: Prompt = {
      start: async () => "create",
      chooseProtection: async () => "password",
      newPassword: async () => "a wallet password only i know",
      password: async () => "a wallet password only i know",
      showPhrase: async (w) => {
        words.splice(0, words.length, ...w);
      },
      confirmPhrase: async (positions) => positions.map((p) => words[p - 1] ?? ""),
      phrase: async () => "",
      approve: async () => true,
      notice() {},
      finished() {},
    };
    const store = memoryStore();
    const wallet = createEmbeddedWallet({
      store,
      // No passkey in a test run: the wallet falls back to its own password.
      passkeys: {
        create: async () => {
          throw new PrfUnsupported();
        },
        get: async () => {
          throw new PrfUnsupported();
        },
      },
      prompt,
      random: (n) => new Uint8Array(randomBytes(n)),
      rpId: "wallet.veylo.test",
      now: () => Date.now(),
    });
    const account = await wallet.connect("create");
    // The account is the implicit account of the key the phrase makes: nothing else holds it.
    expect(account.accountId).toBe(keyFromPhrase(words.join(" ")).accountId);
    expect(account.accountId).toMatch(/^[0-9a-f]{64}$/);
    const request = {
      message: "Pay Ada 100 USDC",
      recipient: "veylo.test",
      nonce: new Uint8Array(32).fill(3),
    };
    const signed = await wallet.signMessage(request);
    expect(
      verifyNep413({ ...request, publicKey: signed.publicKey, signature: signed.signature }),
    ).toBe(true);
    expect(JSON.stringify(await store.list())).not.toContain(words[0] ?? "~"); // only ciphertext is stored
  });
});

async function checkDemo(w: ReturnType<typeof createDemoWorld>) {
  await w.fetch(new URL("/auth/verify", "https://demo.invalid"), { method: "POST" });
  const api = createApiClient({ origin: "https://demo.invalid", fetch: w.fetch as typeof fetch });
  const { ORG, OPEN_RUN, ITEM_OPEN } = w.ids;
  const run = await api.call("GET /orgs/:orgId/pay-runs/:payRunId", {
    params: { orgId: ORG, payRunId: OPEN_RUN },
  });
  const registry = await api.call("GET /orgs/:orgId/payee-registry", { params: { orgId: ORG } });
  const signRequest = await api.call(
    "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request",
    {
      params: { orgId: ORG, payRunId: OPEN_RUN, itemId: ITEM_OPEN },
    },
  );
  const account = await w.wallet.connect();
  return runGates({
    orgId: ORG,
    treasuryAccountId: account.accountId,
    walletPublicKey: account.publicKey ?? "",
    authRecipient: w.authRecipient,
    deadlineMinutes: 15,
    registry,
    items: [{ item: run.items.find((i) => i.id === ITEM_OPEN)!, signRequest }],
    rpc: w.gateRpc,
    highWater: w.highWater,
    now: w.now(),
  });
}
