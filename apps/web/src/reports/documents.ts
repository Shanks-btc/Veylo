// The payslip and the period statement (slice W5, D4). Both are built from the ledger the app has
// already loaded. A payout's proof is its verify page; a private payout says "confidential" and
// carries the evidence condition, and nothing more is claimed.
import { PAYOUT_ROUTES, addMoney, formatFixed, parseAmount, USDC } from "@veylo/core";
import type { ledgerResponse, payslipResponse, portalPayslips } from "@veylo/contract";
import type { z } from "zod";
import { PRIVACY_CONDITION } from "../site";
import { renderPdf, wrap, type PdfLine } from "./pdf";

type Entry = z.infer<typeof ledgerResponse>["items"][number];
export type PayoutEntry = Extract<Entry, { kind: "payout" }>;
type Payslip = z.infer<typeof payslipResponse>;

export const verifyUrl = (appOrigin: string, itemId: string) =>
  `${appOrigin}/verify?payout=${itemId}`;

const isPrivate = (route: string | null) =>
  PAYOUT_ROUTES.find((r) => r.id === route)?.payoutMode === "private";

const routeName = (route: string | null) =>
  PAYOUT_ROUTES.find((r) => r.id === route)?.label ?? "Unknown route";

const CONFIDENTIAL_NOTE =
  "Paid from the confidential balance: there is no public transaction to link to this payout.";

/** One payout's proof, as lines: its verify link, or the confidential note and the condition. */
function proofLines(route: string | null, link: string): PdfLine[] {
  if (isPrivate(route))
    return [
      { text: "Proof: confidential", bold: true, gap: 6 },
      ...wrap(CONFIDENTIAL_NOTE, 90).map((text) => ({ text })),
      ...wrap(PRIVACY_CONDITION, 90).map((text, i) => ({ text, gap: i === 0 ? 4 : 0, size: 9 })),
      { text: link, link, size: 9, gap: 4 },
    ];
  return [
    { text: "Proof: verify this payout", bold: true, gap: 6 },
    { text: link, link },
  ];
}

/** What the contractor received: for NEAR, the NEAR amount, the rate and when the quote was made. */
export function paidLines(p: {
  paidCurrency: "USDC" | "NEAR";
  paidAmount: string | null;
  rate: string | null;
  quoteAsOf: string | null;
}): PdfLine[] {
  const row = (label: string, value: string): PdfLine => ({ text: `${label}: ${value}` });
  const lines = [row("Paid in", `${p.paidAmount ?? "unknown"} ${p.paidCurrency}`)];
  if (p.paidCurrency === "NEAR")
    lines.push(
      row("Rate", `${p.rate ?? "unknown"} USDC per NEAR, fee included`),
      row("Quote time", p.quoteAsOf ?? "unknown"),
    );
  return lines;
}

export function payslipPdf(input: {
  company: string;
  contractorName: string;
  itemId: string;
  /** The route's id, from the ledger entry (the API's payslip carries only the route's label). */
  routeId: string | null;
  payslip: Payslip;
  appOrigin: string;
}): Uint8Array {
  const p = input.payslip;
  const row = (label: string, value: string): PdfLine => ({ text: `${label}: ${value}` });
  const lines: PdfLine[] = [
    { text: "Payslip", size: 20, bold: true },
    { text: input.company, size: 12, gap: 4 },
    row("Contractor", input.contractorName),
    row("Period", p.period),
    { text: "", gap: 8 },
    row("USD value", `${p.amount ?? "unknown"} ${p.currency}`),
    ...paidLines(p),
    row("Route", p.route ?? routeName(input.routeId)),
    row("Status", p.status),
    row("Fee", `${p.totalFee ?? "0.000000"} ${p.currency}`),
    row("Payslip ID", input.itemId),
    ...proofLines(input.routeId, verifyUrl(input.appOrigin, input.itemId)),
    { text: "This payslip lists what was recorded for this payout.", size: 8, gap: 16 },
  ];
  return renderPdf(`Payslip ${p.period} ${input.contractorName}`, lines);
}

type PortalSlip = z.infer<typeof portalPayslips>["payslips"][number];

/** A contractor's own payslip, from the portal's row. The portal carries the route's label, not its id. */
export function portalPayslipPdf(input: {
  company: string;
  contractorName: string;
  slip: PortalSlip;
  appOrigin: string;
}): Uint8Array {
  const s = input.slip;
  const row = (label: string, value: string): PdfLine => ({ text: `${label}: ${value}` });
  const routeId = PAYOUT_ROUTES.find((r) => r.label === s.route)?.id ?? null;
  const lines: PdfLine[] = [
    { text: "Payslip", size: 20, bold: true },
    { text: input.company, size: 12, gap: 4 },
    row("Contractor", input.contractorName),
    row("Period", s.period),
    { text: "", gap: 8 },
    row("USD value", `${s.amount ?? "unknown"} ${s.currency}`),
    ...paidLines(s),
    row("Route", s.route ?? "Unknown route"),
    row("Status", s.status),
    row("Payslip ID", s.itemId),
    ...proofLines(routeId, verifyUrl(input.appOrigin, s.itemId)),
    { text: "This payslip lists what was recorded for this payout.", size: 8, gap: 16 },
  ];
  return renderPdf(`Payslip ${s.period} ${input.contractorName}`, lines);
}

export type Statement = {
  period: string;
  rows: PayoutEntry[];
  /** Paid (SUCCESS) payouts only, summed exactly from the ledger's amounts. */
  paidTotal: string;
  paidCount: number;
  otherCount: number;
};

/** The statement's numbers come from the ledger entries given, and from nowhere else. */
export function buildStatement(entries: readonly Entry[], period: string): Statement {
  const rows = entries
    .filter((e): e is PayoutEntry => e.kind === "payout" && e.period === period)
    .sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)));
  let total = parseAmount("0", USDC);
  let paidCount = 0;
  for (const r of rows) {
    if (r.status !== "SUCCESS" || r.amount === null) continue;
    total = addMoney(total, parseAmount(r.amount, USDC));
    paidCount += 1;
  }
  return {
    period,
    rows,
    paidTotal: formatFixed(total.units, 6),
    paidCount,
    otherCount: rows.length - paidCount,
  };
}

export function statementPdf(input: {
  company: string;
  statement: Statement;
  appOrigin: string;
}): Uint8Array {
  const s = input.statement;
  const lines: PdfLine[] = [
    { text: `Statement ${s.period}`, size: 20, bold: true },
    { text: input.company, size: 12, gap: 4 },
    {
      text: `${s.rows.length} payout${s.rows.length === 1 ? "" : "s"}: ${s.paidCount} paid, ${s.otherCount} not paid`,
      gap: 8,
    },
  ];
  for (const r of s.rows) {
    const link = verifyUrl(input.appOrigin, r.itemId);
    lines.push(
      {
        text: `${r.at.slice(0, 10)}  ${r.contractor.name}  ${r.amount ?? "unknown"} ${r.currency}  ${r.status}${r.paidCurrency === "NEAR" ? `  paid ${r.paidAmount ?? "?"} NEAR at ${r.rate ?? "?"}` : ""}`,
        bold: true,
        gap: 10,
      },
      {
        text: `${routeName(r.route)}. ${isPrivate(r.route) ? "Proof: confidential" : "Proof:"}`,
        size: 9,
      },
      { text: link, link, size: 9 },
    );
  }
  lines.push(
    {
      text: `Total paid: ${s.paidTotal} USDC (${s.paidCount} payout${s.paidCount === 1 ? "" : "s"})`,
      bold: true,
      size: 12,
      gap: 16,
    },
    ...wrap(PRIVACY_CONDITION, 95).map((text, i) => ({ text, size: 8, gap: i === 0 ? 10 : 0 })),
  );
  return renderPdf(`Statement ${s.period}`, lines);
}
