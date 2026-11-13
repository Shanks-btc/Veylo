"use client";
// Statements (slice W6): one month's payouts with their proof links and the paid total, as a PDF or a
// CSV. The total is summed exactly from the ledger's own amounts (never from another source), and an
// estimate in your display currency is shown beside it, for reading only.
import { parseAmount, USDC } from "@veylo/core";
import { useEffect, useState } from "react";
import type { ledgerResponse } from "@veylo/contract";
import type { z } from "zod";
import { Estimate, FxNote } from "../app-ui/fx";
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useApi, useOrg, useSession } from "../app-ui/session";
import { formatDate, StateTag } from "../app-ui/format";
import { buildStatement, statementPdf, verifyUrl, type PayoutEntry } from "../reports/documents";
import { downloadBytes } from "../reports/download";
import { AmountText, Button, EmptyState, Field, Skeleton } from "../ui/basic";
import { Table } from "../ui/data";
import { Card } from "../ui/interactive";

type Entry = z.infer<typeof ledgerResponse>["items"][number];

const quote = (v: string) => `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replaceAll('"', '""')}"`;

function Statements({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const org = useOrg();
  const [entries, setEntries] = useState<Entry[]>();
  const [error, setError] = useState<string>();
  const [period, setPeriod] = useState("");
  const settings = useApi(
    () => api.call("GET /orgs/:orgId/settings", { params: { orgId } }),
    [orgId],
  );

  const load = async () => {
    setError(undefined);
    setEntries(undefined);
    try {
      let cursor: string | undefined;
      const all: Entry[] = [];
      // The whole ledger, a page at a time (live payouts only).
      for (let page = 0; page < 20; page += 1) {
        const r = await api.call("GET /orgs/:orgId/ledger", {
          params: { orgId },
          query: { limit: "200", ...(cursor ? { cursor } : {}) },
        });
        all.push(...r.items);
        cursor = r.nextCursor ?? undefined;
        if (!cursor) break;
      }
      setEntries(all);
      const periods = [
        ...new Set(all.filter((e) => e.kind === "payout").map((e) => (e as PayoutEntry).period)),
      ].sort();
      setPeriod((p) => p || periods.at(-1) || "");
    } catch {
      setError("Couldn't load your ledger. Check your connection, then try again.");
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  if (error) return <ErrorNote error={error} onRetry={() => void load()} />;
  if (!entries) return <Skeleton lines={4} label="Loading statements" />;
  const periods = [
    ...new Set(entries.filter((e) => e.kind === "payout").map((e) => (e as PayoutEntry).period)),
  ]
    .sort()
    .reverse();
  if (periods.length === 0)
    return (
      <EmptyState title="No statements yet" icon="file">
        Once a pay run has payouts, its monthly statement appears here.
      </EmptyState>
    );
  const s = buildStatement(entries, period || periods[0] || "");
  const currency = settings.data?.displayCurrency;

  function csv() {
    const head = [
      "date",
      "contractor",
      "usd value",
      "paid currency",
      "paid amount",
      "rate (USDC per NEAR)",
      "status",
      "verify link",
    ];
    const rows = s.rows.map((r) =>
      [
        r.at.slice(0, 10),
        r.contractor.name,
        r.amount ?? "",
        r.paidCurrency,
        r.paidAmount ?? "",
        r.rate ?? "",
        r.status,
        verifyUrl(window.location.origin, r.itemId),
      ]
        .map(quote)
        .join(","),
    );
    rows.push(
      ["total paid", "", s.paidTotal, "USDC", "", "", `${s.paidCount} paid`, ""]
        .map(quote)
        .join(","),
    );
    downloadBytes(
      new TextEncoder().encode([head.join(","), ...rows].join("\r\n")),
      `statement-${s.period}.csv`,
      "text/csv",
    );
  }

  return (
    <div className="stack">
      <Card>
        <div className="filters">
          <Field id="st-period" label="Month">
            <select id="st-period" value={s.period} onChange={(e) => setPeriod(e.target.value)}>
              {periods.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <div className="stack">
            <span className="muted small">Paid in {s.period}</span>
            <strong>
              <AmountText value={s.paidTotal} /> USDC
            </strong>
            <Estimate usdUnits={parseAmount(s.paidTotal, USDC).units} currency={currency} />
          </div>
          <div className="actions">
            <Button
              onClick={() =>
                downloadBytes(
                  statementPdf({
                    company: org?.orgName ?? "",
                    statement: s,
                    appOrigin: window.location.origin,
                  }),
                  `statement-${s.period}.pdf`,
                )
              }
            >
              Download PDF
            </Button>
            <Button variant="grey" onClick={csv}>
              Download CSV
            </Button>
          </div>
        </div>
      </Card>
      <FxNote currency={currency} />
      <Table
        caption={`Statement ${s.period}`}
        rows={s.rows}
        rowKey={(r) => r.id}
        columns={[
          { key: "at", label: "Date", render: (r) => formatDate(r.at) },
          { key: "who", label: "Contractor", render: (r) => r.contractor.name },
          {
            key: "amount",
            label: "USD value",
            align: "right",
            render: (r) => <AmountText value={r.amount} />,
          },
          {
            key: "paid",
            label: "Paid in",
            render: (r) =>
              r.paidCurrency === "NEAR"
                ? `${r.paidAmount ?? "?"} NEAR at ${r.rate ?? "?"}`
                : "USDC",
          },
          { key: "state", label: "State", render: (r) => <StateTag status={r.status} /> },
          {
            key: "verify",
            label: "Proof",
            render: (r) => <a href={`/verify?payout=${r.itemId}`}>Verify</a>,
          },
        ]}
      />
      <p className="page-note">
        {s.paidCount} paid, {s.otherCount} not paid. The total counts only paid payouts, summed from
        the ledger.
      </p>
    </div>
  );
}

export function StatementsScreen() {
  return (
    <>
      <PageHeader eyebrow="Money" title="Statements">
        A month at a time, for you and your accountant.
      </PageHeader>
      <NeedsOrg>{(orgId) => <Statements orgId={orgId} />}</NeedsOrg>
    </>
  );
}
