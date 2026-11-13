"use client";
// Screens 6, 7 and 8: pay runs, review and sign, and payout status.
import { useEffect, useMemo, useState } from "react";
import type { payRun, payRunItem, signRequestResponse } from "@veylo/contract";
import type { z } from "zod";
import { runGates, type GateReport } from "../gates";
import { earliestSigningBound, flagText, signPayRun } from "../signing/pay-run";
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useApi, useQueryParam, useSession, webConfig, useOrg } from "../app-ui/session";
import { RouteTag, RunTag, StateTag, formatDate } from "../app-ui/format";
import { AmountText, ButtonLink, EmptyState, Skeleton, Tag } from "../ui/basic";
import { Table } from "../ui/data";
import { Card, useToast } from "../ui/interactive";
import { payoutProof, ProofCell } from "./payout-proof";
import { DemoTamper } from "./demo-tamper";
import { SignPanel } from "./sign-panel";

type Run = z.infer<typeof payRun>;
type Item = z.infer<typeof payRunItem>;
type SignRequest = z.infer<typeof signRequestResponse>;

/** Signing closes a minute before the bound: the gate wants 60 s left (L35). */
const CLOSE_EARLY_MS = 60_000;

function useContractors(orgId: string) {
  const { api } = useSession();
  const res = useApi(
    () => api.call("GET /orgs/:orgId/contractors", { params: { orgId } }),
    [orgId],
  );
  return useMemo(
    () => new Map((res.data?.contractors ?? []).map((c) => [c.id, c] as const)),
    [res.data],
  );
}

/** Why an item can't be signed now, or undefined when it can. */
export function heldReason(item: Item): string | undefined {
  if (item.blocked) {
    const flags = item.flags.filter((f) => f.blocking);
    return flags.length > 0
      ? flags.map((f) => f.detail ?? f.code.replaceAll("_", " ")).join("; ")
      : "Blocked by a check";
  }
  if (!item.attempt) return "No quote yet";
  if (item.attempt.status !== "QUOTED") return `Payout is ${item.attempt.status}`;
  return undefined;
}

export function PayRunsScreen() {
  const { api } = useSession();
  return (
    <NeedsOrg>
      {(orgId) => (
        <RunList
          orgId={orgId}
          load={() => api.call("GET /orgs/:orgId/pay-runs", { params: { orgId } })}
        />
      )}
    </NeedsOrg>
  );
}

function RunList({
  orgId,
  load,
}: {
  orgId: string;
  load: () => Promise<{
    payRuns: {
      id: string;
      period: string;
      status: string;
      simulated: boolean;
      totalAmount: string;
    }[];
  }>;
}) {
  const runs = useApi(load, [orgId]);
  return (
    <>
      <PageHeader eyebrow="Payroll" title="Pay runs" />
      {runs.loading ? (
        <Skeleton lines={4} label="Loading pay runs" />
      ) : runs.error || !runs.data ? (
        <ErrorNote error={runs.error ?? "No pay runs"} onRetry={runs.reload} />
      ) : runs.data.payRuns.length === 0 ? (
        <EmptyState title="No pay runs yet" icon="calendar">
          Pay runs you create appear here.
        </EmptyState>
      ) : (
        <Table
          caption="Pay runs"
          rows={runs.data.payRuns}
          rowKey={(r) => r.id}
          columns={[
            { key: "period", label: "Period", render: (r) => r.period },
            { key: "status", label: "Status", render: (r) => <RunTag status={r.status} /> },
            {
              key: "mode",
              label: "Mode",
              render: (r) => <Tag tone="neutral">{r.simulated ? "Simulated" : "Live"}</Tag>,
            },
            {
              key: "total",
              label: "Total",
              align: "right",
              render: (r) => <AmountText value={r.totalAmount} />,
            },
            {
              key: "open",
              label: "Open",
              render: (r) => (
                <span className="row">
                  <a href={`/app/pay-run?id=${r.id}`}>Review</a>
                  <a href={`/app/pay-run/status?id=${r.id}`}>Status</a>
                </span>
              ),
            },
          ]}
        />
      )}
    </>
  );
}

function ItemsTable({
  run,
  contractors,
  caption,
}: {
  run: Run;
  contractors: ReturnType<typeof useContractors>;
  caption: string;
}) {
  return (
    <Table
      caption={caption}
      rows={run.items}
      rowKey={(i) => i.id}
      columns={[
        {
          key: "who",
          label: "Payee",
          render: (i) => {
            const reason = heldReason(i);
            return (
              <span className="held">
                <span>{contractors.get(i.contractorId)?.name ?? "Contractor"}</span>
                {reason ? <span className="reason">Held back: {reason}</span> : null}
              </span>
            );
          },
        },
        {
          key: "route",
          label: "Route",
          render: (i) => <RouteTag mode={contractors.get(i.contractorId)?.payoutMode ?? null} />,
        },
        {
          key: "amount",
          label: "Amount",
          align: "right",
          render: (i) => <AmountText value={i.amount} />,
        },
        {
          key: "fee",
          label: "Quoted fee",
          align: "right",
          render: (i) => <AmountText value={i.feePreview?.fee ?? null} />,
        },
      ]}
    />
  );
}

function Review({ orgId, payRunId }: { orgId: string; payRunId: string }) {
  const { api, connectWallet, gateDeps, now: clock } = useSession();
  const isOwner = useOrg()?.role === "owner";
  const toast = useToast();
  const contractors = useContractors(orgId);
  const run = useApi(
    () => api.call("GET /orgs/:orgId/pay-runs/:payRunId", { params: { orgId, payRunId } }),
    [orgId, payRunId],
  );
  const [report, setReport] = useState<GateReport>();
  const [requests, setRequests] = useState<{ item: Item; signRequest: SignRequest }[]>([]);
  const [checking, setChecking] = useState(false);
  const [signing, setSigning] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [now, setNow] = useState(() => clock().getTime());
  const [error, setError] = useState<string>();

  const gated = (run.data?.items ?? []).filter((i) => !heldReason(i));
  // Warnings the owner must read and tick before the checks run (D5).
  const warned = gated.filter((i) => i.flags.some((f) => !f.blocking));
  const [acked, setAcked] = useState<ReadonlySet<string>>(new Set());
  const unacknowledged = warned.filter((i) => !acked.has(i.id)).length;
  async function onAcknowledge(itemId: string) {
    try {
      await api.call("POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/acknowledge", {
        params: { orgId, payRunId, itemId },
      });
      setAcked((s) => new Set(s).add(itemId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your tick");
    }
  }
  const bound = earliestSigningBound(
    requests.map((r) => r.signRequest),
    webConfig.payoutQuoteDeadlineMinutes,
  );
  const msLeft = bound ? bound.getTime() - CLOSE_EARLY_MS - now : undefined;

  const boundMs = bound?.getTime();
  useEffect(() => {
    if (boundMs === undefined) return;
    const t = window.setInterval(() => setNow(clock().getTime()), 1000);
    return () => window.clearInterval(t);
  }, [boundMs]);

  // No decorative motion anywhere while a signature is pending.
  useEffect(() => {
    if (!signing) return;
    document.documentElement.dataset.motion = "reduce";
    return () => {
      delete document.documentElement.dataset.motion;
    };
  }, [signing]);

  async function onCheck() {
    if (!run.data) return;
    setChecking(true);
    setError(undefined);
    setReport(undefined);
    try {
      const wallet = await connectWallet();
      const registry = await api.call("GET /orgs/:orgId/payee-registry", { params: { orgId } });
      const signed: { item: Item; signRequest: SignRequest }[] = [];
      for (const item of gated) {
        const signRequest = await api.call(
          "POST /orgs/:orgId/pay-runs/:payRunId/items/:itemId/sign-request",
          { params: { orgId, payRunId, itemId: item.id } },
        );
        signed.push({ item, signRequest });
      }
      setRequests(signed);
      const deps = await gateDeps();
      const r = await runGates({
        orgId,
        treasuryAccountId: wallet.accountId,
        walletPublicKey: wallet.publicKey ?? "",
        authRecipient: deps.authRecipient,
        deadlineMinutes: webConfig.payoutQuoteDeadlineMinutes,
        registry,
        items: signed,
        rpc: deps.rpc,
        highWater: deps.highWater,
        now: deps.now,
      });
      setNow(deps.now.getTime());
      setReport(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The checks couldn't run");
    } finally {
      setChecking(false);
    }
  }

  async function onSign() {
    if (!report) return;
    setSigning(true);
    setError(undefined);
    try {
      const wallet = await connectWallet();
      const out = await signPayRun({
        api,
        wallet: wallet.signer,
        orgId,
        payRunId,
        treasuryAccountId: wallet.accountId,
        walletPublicKey: wallet.publicKey ?? "",
        report,
        items: requests,
        onProgress: (done, total) => setProgress(`Signed ${done} of ${total}…`),
      });
      toast("success", `${out.submitted} payout${out.submitted === 1 ? "" : "s"} signed and sent.`);
      window.location.assign(`/app/pay-run/status?id=${payRunId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signing failed");
    } finally {
      setSigning(false);
      setProgress(undefined);
    }
  }

  if (run.loading && !run.data) return <Skeleton lines={5} label="Loading pay run" />;
  if (run.error || !run.data)
    return <ErrorNote error={run.error ?? "Not found"} onRetry={run.reload} />;
  const names = new Map(
    run.data.items.map((i) => [i.id, contractors.get(i.contractorId)?.name ?? "a payout"] as const),
  );
  return (
    <>
      <PageHeader
        eyebrow={`Pay run · ${run.data.simulated ? "simulated" : "live"}`}
        title={`Review ${run.data.period}`}
        actions={<RunTag status={run.data.status} />}
      >
        Each payout is checked in this browser before your treasury wallet signs.
      </PageHeader>
      {error ? <ErrorNote error={error} /> : null}
      <div className="review">
        <div className="stack">
          <ItemsTable run={run.data} contractors={contractors} caption="Payouts in this run" />
          {isOwner && warned.length > 0 ? (
            <Card size="sm" className="warnings">
              <h2 className="section-title">Check these before signing</h2>
              <ul className="list-plain">
                {warned.map((i) => (
                  <li key={i.id}>
                    <label className="ack">
                      <input
                        type="checkbox"
                        checked={acked.has(i.id)}
                        onChange={() => onAcknowledge(i.id)}
                        disabled={acked.has(i.id)}
                      />
                      <span>
                        <strong>{contractors.get(i.contractorId)?.name ?? "Payout"}</strong>:{" "}
                        {i.flags
                          .filter((f) => !f.blocking)
                          .map((f) => flagText(f.code, f.detail))
                          .join(" ")}{" "}
                        I&apos;ve checked this.
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          <Card size="sm">
            <div className="spread">
              <span className="muted">Payouts</span>
              <AmountText value={run.data.totals.payoutSum} />
            </div>
            <div className="spread">
              <span className="muted">Fees</span>
              <AmountText value={run.data.totals.feeSum} />
            </div>
            <div className="spread">
              <strong>Total</strong>
              <AmountText value={run.data.totals.grandTotal} />
            </div>
          </Card>
        </div>
        <div className="stack">
          {isOwner ? <DemoTamper onChange={onCheck} disabled={checking || signing} /> : null}
          {!isOwner ? (
            <Card size="sm">
              <p className="small">
                Only the organisation&apos;s owner reviews quotes and approves payouts, with the
                treasury wallet. You can prepare the pay run; the owner takes it from here.
              </p>
            </Card>
          ) : (
            <SignPanel
              report={report}
              names={names}
              checking={checking}
              signing={signing}
              msLeft={msLeft}
              count={gated.length}
              unacknowledged={unacknowledged}
              progress={progress}
              onCheck={onCheck}
              onSign={onSign}
            />
          )}
        </div>
      </div>
    </>
  );
}

function Status({ orgId, payRunId }: { orgId: string; payRunId: string }) {
  const { api } = useSession();
  const contractors = useContractors(orgId);
  const run = useApi(
    () => api.call("GET /orgs/:orgId/pay-runs/:payRunId", { params: { orgId, payRunId } }),
    [orgId, payRunId],
  );
  const ledger = useApi(() => api.call("GET /orgs/:orgId/ledger", { params: { orgId } }), [orgId]);
  // The latest attempt's ledger entry per item: its explorer links.
  const links = new Map<string, { destinationTx: string | null; nearTxs: readonly string[] }>();
  for (const e of [...(ledger.data?.items ?? [])].sort((a, b) =>
    a.kind === "payout" && b.kind === "payout" ? a.attemptNo - b.attemptNo : 0,
  ))
    if (e.kind === "payout" && e.payRunId === payRunId) links.set(e.itemId, e.links);
  if (run.loading && !run.data) return <Skeleton lines={5} label="Loading pay run" />;
  if (run.error || !run.data)
    return <ErrorNote error={run.error ?? "Not found"} onRetry={run.reload} />;
  return (
    <>
      <PageHeader
        eyebrow="Pay run status"
        title={run.data.period}
        actions={
          <>
            <RunTag status={run.data.status} />
            <button type="button" className="btn btn-grey btn-sm" onClick={run.reload}>
              Refresh
            </button>
          </>
        }
      />
      <Table
        caption="Payout status"
        rows={run.data.items}
        rowKey={(i) => i.id}
        columns={[
          {
            key: "who",
            label: "Payee",
            render: (i) => contractors.get(i.contractorId)?.name ?? "Contractor",
          },
          {
            key: "route",
            label: "Route",
            render: (i) => <RouteTag mode={contractors.get(i.contractorId)?.payoutMode ?? null} />,
          },
          {
            key: "amount",
            label: "Amount",
            align: "right",
            render: (i) => <AmountText value={i.amount} />,
          },
          { key: "state", label: "State", render: (i) => <StateTag status={i.attempt?.status} /> },
          {
            key: "tx",
            label: "Transaction",
            render: (i) => (
              <span className="held">
                <ProofCell
                  proof={payoutProof(
                    contractors.get(i.contractorId)?.payoutMode ?? null,
                    links.get(i.id),
                  )}
                />
                {i.attempt?.status === "SUCCESS" ? (
                  <a href={`/verify?payout=${i.id}`}>Verify this payout</a>
                ) : null}
              </span>
            ),
          },
          {
            key: "note",
            label: "Note",
            render: (i) =>
              i.attempt?.failureReason ? (
                <span className="small">{i.attempt.failureReason}</span>
              ) : i.attempt?.quoteDeadline ? (
                <span className="small muted">
                  Quote until {formatDate(i.attempt.quoteDeadline)}
                </span>
              ) : (
                <span className="small muted">—</span>
              ),
          },
        ]}
      />
      <ButtonLink href={`/app/pay-run?id=${payRunId}`} variant="grey" small>
        Back to review
      </ButtonLink>
    </>
  );
}

function WithRun({ view }: { view: "review" | "status" }) {
  const id = useQueryParam("id");
  return (
    <NeedsOrg>
      {(orgId) =>
        id === undefined ? (
          <Skeleton lines={3} />
        ) : id === null ? (
          <ErrorNote error="No pay run chosen." />
        ) : view === "review" ? (
          <Review orgId={orgId} payRunId={id} />
        ) : (
          <Status orgId={orgId} payRunId={id} />
        )
      }
    </NeedsOrg>
  );
}

export const PayRunReviewScreen = () => <WithRun view="review" />;
export const PayRunStatusScreen = () => <WithRun view="status" />;
