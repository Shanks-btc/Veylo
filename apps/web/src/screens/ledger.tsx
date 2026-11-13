"use client";
// Screen 9: the ledger, payslips, and the payouts CSV for a date range.
import { useState, type FormEvent } from "react";
import type { ledgerResponse, payslipResponse } from "@veylo/contract";
import type { z } from "zod";
import { ApiError } from "../api/client";
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useApi, useOrg, useSession } from "../app-ui/session";
import { downloadBytes } from "../reports/download";
import { buildStatement, payslipPdf, statementPdf } from "../reports/documents";
import { formatDate, routeLabel, StateTag, unitsToDecimal } from "../app-ui/format";
import { AmountText, Button, EmptyState, Field, Skeleton, Tag } from "../ui/basic";
import { Table } from "../ui/data";
import { Card, Modal, useToast } from "../ui/interactive";

type Entry = z.infer<typeof ledgerResponse>["items"][number];
type Payslip = z.infer<typeof payslipResponse>;

const day = (d: Date) => d.toISOString().slice(0, 10);

function CsvExport({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const toast = useToast();
  const today = new Date();
  const [from, setFrom] = useState(
    day(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))),
  );
  const [to, setTo] = useState(day(today));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const csv = await api.call("GET /orgs/:orgId/exports/payouts.csv", {
        params: { orgId },
        query: { from, to },
      });
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `veylo-payouts-${from}-to-${to}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast("success", "CSV downloaded.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't export the CSV.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card size="sm">
      <form className="row" onSubmit={onSubmit}>
        <Field id="csv-from" label="From">
          <input id="csv-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field id="csv-to" label="To">
          <input id="csv-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? "Exporting…" : "Export CSV"}
        </Button>
      </form>
      {error ? <ErrorNote error={error} /> : null}
    </Card>
  );
}

function PayslipModal({
  orgId,
  entry,
  onClose,
}: {
  orgId: string;
  entry: Extract<Entry, { kind: "payout" }> | undefined;
  onClose: () => void;
}) {
  const { api } = useSession();
  const org = useOrg();
  const slip = useApi<Payslip | undefined>(
    entry
      ? () =>
          api.call("GET /orgs/:orgId/pay-runs/:payRunId/items/:itemId/payslip", {
            params: { orgId, payRunId: entry.payRunId, itemId: entry.itemId },
          })
      : undefined,
    [orgId, entry?.id],
  );
  return (
    <Modal open={entry !== undefined} title="Payslip" onClose={onClose}>
      {!entry ? null : slip.loading ? (
        <Skeleton lines={4} label="Loading payslip" />
      ) : slip.error || !slip.data ? (
        <ErrorNote error={slip.error ?? "No payslip"} />
      ) : (
        <dl className="list-plain">
          <div className="spread">
            <dt className="muted">Contractor</dt>
            <dd>{slip.data.contractor.name}</dd>
          </div>
          <div className="spread">
            <dt className="muted">Period</dt>
            <dd>{slip.data.period}</dd>
          </div>
          <div className="spread">
            <dt className="muted">Amount</dt>
            <dd>
              <AmountText value={slip.data.amount} />
            </dd>
          </div>
          <div className="spread">
            <dt className="muted">Route</dt>
            <dd>{slip.data.route ?? "No route"}</dd>
          </div>
          <div className="spread">
            <dt className="muted">Fee</dt>
            <dd>
              <AmountText value={slip.data.totalFee} />
            </dd>
          </div>
          <div className="spread">
            <dt className="muted">State</dt>
            <dd>
              <StateTag status={slip.data.status} />
            </dd>
          </div>
          <div className="spread">
            <dt className="muted">Proof</dt>
            <dd>
              {entry ? <a href={`/verify?payout=${entry.itemId}`}>Verify this payout</a> : null}
            </dd>
          </div>
          <div className="spread">
            <dt className="muted">Document</dt>
            <dd>
              {entry ? (
                <Button
                  small
                  variant="grey"
                  onClick={() =>
                    downloadBytes(
                      payslipPdf({
                        company: org?.orgName ?? "",
                        contractorName: entry.contractor.name,
                        itemId: entry.itemId,
                        routeId: entry.route,
                        payslip: slip.data as Payslip,
                        appOrigin: window.location.origin,
                      }),
                      `payslip-${entry.period}-${entry.itemId.slice(0, 8)}.pdf`,
                    )
                  }
                >
                  Download payslip (PDF)
                </Button>
              ) : null}
            </dd>
          </div>
        </dl>
      )}
    </Modal>
  );
}

/** The period statement (D4): every payout in a month with its proof link, and the paid total. */
function StatementCard({ entries }: { entries: readonly Entry[] }) {
  const org = useOrg();
  const periods = [
    ...new Set(
      entries.filter((e) => e.kind === "payout").map((e) => (e as { period: string }).period),
    ),
  ].sort();
  const [period, setPeriod] = useState<string>(periods.at(-1) ?? "");
  if (periods.length === 0) return null;
  const s = buildStatement(entries, period);
  return (
    <Card size="sm">
      <div className="row">
        <Field id="statement-period" label="Statement for">
          <select id="statement-period" value={period} onChange={(e) => setPeriod(e.target.value)}>
            {periods.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <p className="small muted">
          {s.rows.length} payout{s.rows.length === 1 ? "" : "s"}, {s.paidTotal} USDC paid
        </p>
        <Button
          variant="grey"
          onClick={() =>
            downloadBytes(
              statementPdf({
                company: org?.orgName ?? "",
                statement: s,
                appOrigin: window.location.origin,
              }),
              `statement-${period}.pdf`,
            )
          }
        >
          Download statement (PDF)
        </Button>
      </div>
    </Card>
  );
}

export function LedgerScreen() {
  return <NeedsOrg>{(orgId) => <Ledger orgId={orgId} />}</NeedsOrg>;
}

function Ledger({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const [open, setOpen] = useState<Extract<Entry, { kind: "payout" }>>();
  const ledger = useApi(() => api.call("GET /orgs/:orgId/ledger", { params: { orgId } }), [orgId]);
  return (
    <>
      <PageHeader eyebrow="Reporting" title="Ledger and payslips">
        Every payout and treasury movement, with its payslip.
      </PageHeader>
      <CsvExport orgId={orgId} />
      {ledger.data ? <StatementCard entries={ledger.data.items} /> : null}
      {ledger.loading ? (
        <Skeleton lines={5} label="Loading ledger" />
      ) : ledger.error || !ledger.data ? (
        <ErrorNote error={ledger.error ?? "No ledger"} onRetry={ledger.reload} />
      ) : ledger.data.items.length === 0 ? (
        <EmptyState title="Nothing in the ledger yet" icon="receipt">
          Payouts and treasury funding appear here once they happen.
        </EmptyState>
      ) : (
        <Table
          caption="Ledger"
          rows={ledger.data.items}
          rowKey={(e) => `${e.kind}-${e.id}`}
          columns={[
            { key: "at", label: "Date", render: (e) => formatDate(e.at) },
            {
              key: "what",
              label: "Entry",
              render: (e) =>
                e.kind === "payout" ? (
                  <span>
                    {e.contractor.name} · {e.period}
                  </span>
                ) : (
                  <span>{e.type === "fund" ? "Treasury funded" : "Moved to private balance"}</span>
                ),
            },
            {
              key: "amount",
              label: "Amount",
              align: "right",
              render: (e) =>
                e.kind === "payout" ? (
                  <AmountText value={e.amount} />
                ) : (
                  <AmountText value={e.destinationAmount ?? unitsToDecimal(e.originAmount)} />
                ),
            },
            { key: "state", label: "State", render: (e) => <StateTag status={e.status} /> },
            {
              key: "verify",
              label: "Verify",
              render: (e) =>
                e.kind === "payout" ? (
                  <a href={`/verify?payout=${e.itemId}`}>Verify</a>
                ) : (
                  <span className="small muted">—</span>
                ),
            },
            {
              key: "mode",
              label: "Mode",
              render: (e) => <Tag tone="neutral">{e.simulated ? "Simulated" : "Live"}</Tag>,
            },
            {
              key: "slip",
              label: "Payslip",
              render: (e) =>
                e.kind === "payout" ? (
                  <button type="button" className="btn btn-grey btn-sm" onClick={() => setOpen(e)}>
                    View
                  </button>
                ) : (
                  <span className="small muted">—</span>
                ),
            },
          ]}
        />
      )}
      <PayslipModal orgId={orgId} entry={open} onClose={() => setOpen(undefined)} />
    </>
  );
}
