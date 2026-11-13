// Payslip and statement PDFs (slice W5, D4).
import { describe, expect, it } from "vitest";
import { createApiClient } from "../api/client";
import { createDemoWorld } from "../demo/world";
import { PRIVACY_CONDITION } from "../site";
import { buildStatement, payslipPdf, statementPdf, verifyUrl, type PayoutEntry } from "./documents";
import { pdfText, renderPdf, wrap } from "./pdf";

const APP = "https://app.veylo.test";
const bytesToString = (b: Uint8Array) => String.fromCharCode(...b);
/** Wrapped lines rejoined, so a long sentence can be searched for as one string. */
const flat = (b: Uint8Array) => pdfText(b).replace(/\s*\n\s*/g, " ");

async function ledgerAndSlips() {
  const w = createDemoWorld();
  await w.fetch(new URL("/auth/verify", "https://demo.invalid"), { method: "POST" });
  const api = createApiClient({ origin: "https://demo.invalid", fetch: w.fetch as typeof fetch });
  const { ORG, DONE_RUN, ITEM_DIRECT, ITEM_PRIVATE } = w.ids;
  const ledger = await api.call("GET /orgs/:orgId/ledger", { params: { orgId: ORG } });
  const slip = (itemId: string) =>
    api.call("GET /orgs/:orgId/pay-runs/:payRunId/items/:itemId/payslip", {
      params: { orgId: ORG, payRunId: DONE_RUN, itemId },
    });
  return { ledger, direct: await slip(ITEM_DIRECT), priv: await slip(ITEM_PRIVATE), ids: w.ids };
}

describe("the PDF writer", () => {
  it("writes a well-formed file: header, trailer, and an xref table whose offsets are right", () => {
    const pdf = renderPdf("Test", [{ text: "Hello", size: 20, bold: true }, { text: "World" }]);
    const s = bytesToString(pdf);
    expect(s.startsWith("%PDF-1.4\n")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    const start = Number(/startxref\n(\d+)/.exec(s)?.[1]);
    expect(s.slice(start, start + 4)).toBe("xref");
    const table = s.slice(start).split("\n").slice(3); // after "xref", "0 N" and the free entry
    const offsets = table
      .filter((l) => /^\d{10} 00000 n $/.test(l))
      .map((l) => Number(l.slice(0, 10)));
    offsets.forEach((off, i) =>
      expect(s.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`),
    );
    expect(offsets.length).toBeGreaterThan(5);
  });

  it("starts a new page when the first is full", () => {
    const lines = Array.from({ length: 140 }, (_, i) => ({ text: `line ${i}` }));
    const s = bytesToString(renderPdf("Long", lines));
    expect(s.match(/\/Type \/Page /g)?.length).toBeGreaterThan(1);
    expect(pdfText(renderPdf("Long", lines)).split("\n")).toHaveLength(140);
  });

  it("escapes brackets and backslashes, and replaces what Latin-1 can't hold", () => {
    const t = pdfText(renderPdf("x", [{ text: "a (b) \\ c é 😀" }]));
    expect(t).toBe("a (b) \\ c é ?");
  });

  it("makes a link line clickable and prints its address too", () => {
    const s = bytesToString(
      renderPdf("x", [{ text: "https://a.test/v?p=1", link: "https://a.test/v?p=1" }]),
    );
    expect(s).toContain("/Subtype /Link");
    expect(s).toContain("/URI (https://a.test/v?p=1)");
    expect(s).toContain("(https://a.test/v?p=1) Tj");
  });

  it("wraps on spaces and never cuts a long word", () => {
    expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
    expect(wrap("https://very.long.example/path/that/does/not/fit", 10)).toEqual([
      "https://very.long.example/path/that/does/not/fit",
    ]);
  });
});

describe("payslip PDF", () => {
  it("a direct payout's payslip carries its verify link, as text and as a link", async () => {
    const { direct, ids } = await ledgerAndSlips();
    const pdf = payslipPdf({
      company: "Northwind Studio (demo)",
      contractorName: "Kwame (demo)",
      itemId: ids.ITEM_DIRECT,
      routeId: "usdc-base",
      payslip: direct,
      appOrigin: APP,
    });
    const link = verifyUrl(APP, ids.ITEM_DIRECT);
    expect(pdfText(pdf)).toContain(link);
    expect(bytesToString(pdf)).toContain(`/URI (${link})`);
    for (const word of [
      "Payslip",
      "Northwind Studio (demo)",
      "Kwame (demo)",
      "2026-10",
      "0.500000 USDC",
      "SUCCESS",
      "0.002400 USDC",
      ids.ITEM_DIRECT,
    ]) {
      expect(pdfText(pdf)).toContain(word);
    }
    expect(flat(pdf)).not.toContain("Proof: confidential");
  });

  it("a private payout's payslip says confidential, carries the evidence condition, and shows no public transaction", async () => {
    const { priv, ids } = await ledgerAndSlips();
    const pdf = payslipPdf({
      company: "Northwind Studio (demo)",
      contractorName: "Ada (demo)",
      itemId: ids.ITEM_PRIVATE,
      routeId: "usdc-near-confidential",
      payslip: priv,
      appOrigin: APP,
    });
    expect(pdfText(pdf)).toContain("Proof: confidential");
    expect(flat(pdf)).toContain(PRIVACY_CONDITION);
    expect(flat(pdf)).toContain("there is no public transaction to link to this payout");
    expect(pdfText(pdf)).not.toMatch(/nearblocks|basescan/);
  });
});

describe("period statement", () => {
  it("lists every payout in the period with its proof link", async () => {
    const { ledger, ids } = await ledgerAndSlips();
    const s = buildStatement(ledger.items, "2026-10");
    const pdf = statementPdf({ company: "Northwind Studio (demo)", statement: s, appOrigin: APP });
    expect(s.rows.map((r) => r.itemId).sort()).toEqual([ids.ITEM_DIRECT, ids.ITEM_PRIVATE].sort());
    for (const r of s.rows) expect(pdfText(pdf)).toContain(verifyUrl(APP, r.itemId));
    expect(flat(pdf)).toContain(PRIVACY_CONDITION);
  });

  // A decoy: amountIn, deliveryFee and totalFee differ from amount, so a total taken from the
  // wrong field (or from any other source) can't equal the ledger's amounts.
  const entry = (n: number, amount: string, status: string, period = "2026-11"): PayoutEntry =>
    ({
      kind: "payout",
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      at: `2026-11-0${n}T10:00:00.000Z`,
      mode: "live",
      simulated: false,
      label: null,
      payRunId: "11111111-1111-4111-8111-111111111111",
      period,
      itemId: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
      contractor: { id: "33333333-3333-4333-8333-333333333333", name: `C${n}` },
      attemptNo: 1,
      status,
      failureReason: null,
      statusHistory: [],
      amount,
      currency: "USDC",
      paidCurrency: "USDC",
      paidAmount: amount,
      rate: null,
      route: "usdc-near-confidential",
      routeLabel: "USDC confidential balance on NEAR",
      chain: "near",
      recipient: null,
      amountIn: "999999.999999",
      minAmountIn: null,
      deliveryFee: "7.000000",
      totalFee: "8.000000",
      quoteAsOf: null,
      refundedAmount: null,
      reconciled: true,
      reconciledAt: null,
      balanceUnconfirmed: null,
      hashes: {
        depositAddress: null,
        correlationId: null,
        intentHash: null,
        settlementIntentHashes: [],
        nearTxHashes: [],
        destinationTxHash: null,
      },
      links: { intentsExplorer: null, nearTxs: [], destinationTx: null },
    }) as PayoutEntry;

  it("the total equals the ledger's amounts, exactly, for paid payouts only", () => {
    const entries = [
      entry(1, "1000.000001", "SUCCESS"),
      entry(2, "250.499999", "SUCCESS"),
      entry(3, "40.000000", "FAILED"),
      entry(4, "5.000000", "REFUNDED"),
      entry(5, "9.000000", "SUCCESS", "2026-12"), // another period
    ];
    const s = buildStatement(entries, "2026-11");
    expect(s).toMatchObject({ paidTotal: "1250.500000", paidCount: 2, otherCount: 2 });
    expect(s.rows).toHaveLength(4);
    // Independent sum, in smallest units.
    const units = (a: string) => BigInt(a.replace(".", ""));
    expect(units(s.paidTotal)).toBe(units("1000.000001") + units("250.499999"));
  });

  it("no floating point: amounts that floats get wrong are summed exactly", () => {
    const s = buildStatement(
      [entry(1, "0.100000", "SUCCESS"), entry(2, "0.200000", "SUCCESS")],
      "2026-11",
    );
    expect(s.paidTotal).toBe("0.300000"); // 0.1 + 0.2 is 0.30000000000000004 in floats
  });

  it("an empty period is an empty statement, not an error", () => {
    expect(buildStatement([entry(1, "1.000000", "SUCCESS")], "2030-01")).toMatchObject({
      rows: [],
      paidTotal: "0.000000",
      paidCount: 0,
    });
  });

  it("the PDF prints the statement's own total", () => {
    const s = buildStatement(
      [entry(1, "1000.000001", "SUCCESS"), entry(2, "250.499999", "SUCCESS")],
      "2026-11",
    );
    expect(pdfText(statementPdf({ company: "Co", statement: s, appOrigin: APP }))).toContain(
      "Total paid: 1250.500000 USDC (2 payouts)",
    );
  });
});

describe("a NEAR payout's documents (W6)", () => {
  it("show the NEAR amount, the USD value, the rate and when the quote was made", () => {
    const pdf = payslipPdf({
      company: "Northwind",
      contractorName: "Kwame",
      itemId: "33333333-3333-4333-8333-333333333333",
      routeId: "near-direct",
      payslip: {
        contractor: { id: "22222222-2222-4222-8222-222222222222", name: "Kwame" },
        period: "2026-11",
        amount: "100.000000",
        currency: "USDC",
        paidCurrency: "NEAR",
        paidAmount: "29.154518950437317784256560",
        rate: "3.442005",
        route: "NEAR",
        chain: "NEAR",
        recipient: "kwame.near",
        deliveryFee: "0.000000",
        totalFee: "0.350000",
        quoteAsOf: "2026-11-26T10:00:00.000Z",
        status: "SUCCESS",
        reconciled: true,
        reconciledAt: "2026-11-26T10:05:00.000Z",
        refundedAmount: null,
        hashes: {
          depositAddress: null,
          correlationId: null,
          intentHash: null,
          settlementIntentHashes: [],
          nearTxHashes: [],
          destinationTxHash: null,
        },
        links: { intentsExplorer: null, nearTxs: [], destinationTx: null },
        timestamps: [],
        attempts: 1,
        mode: "live",
        simulated: false,
        label: null,
      } as never,
      appOrigin: APP,
    });
    const text = pdfText(pdf);
    expect(text).toContain("USD value: 100.000000 USDC");
    expect(text).toContain("Paid in: 29.154518950437317784256560 NEAR");
    expect(text).toContain("Rate: 3.442005 USDC per NEAR, fee included");
    expect(text).toContain("Quote time: 2026-11-26T10:00:00.000Z");
  });
});
