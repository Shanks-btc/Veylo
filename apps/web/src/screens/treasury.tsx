"use client";
// Screen 3: treasury home. Balance (read live by the API from NEAR), what unsigned runs reserve,
// the next pay run, and what waits on the owner.
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useApi, useOrg, useSession } from "../app-ui/session";
import { BalanceStatsView } from "../app-ui/balance-stats";
import { PrivateSessionButton } from "../app-ui/private-session";
import { OWNER_RUN_STATUSES, RunTag, sumDecimals, UNSIGNED_RUN_STATUSES } from "../app-ui/format";
import { AmountText, ButtonLink, Skeleton, Stat } from "../ui/basic";
import { Card } from "../ui/interactive";

function Balance({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const isOwner = useOrg()?.role === "owner";
  const b = useApi(
    () => api.call("GET /orgs/:orgId/treasury/balances", { params: { orgId } }),
    [orgId],
  );
  if (b.loading) return <Skeleton lines={2} label="Loading balances" />;
  if (b.error || !b.data) return <ErrorNote error={b.error ?? "No balance"} onRetry={b.reload} />;
  return (
    <BalanceStatsView
      confidential={b.data.confidential}
      pub={b.data.public}
      isOwner={isOwner}
      connect={
        <PrivateSessionButton
          kind={{ type: "treasury", orgId }}
          onOpened={b.reload}
          label="Connect your wallet"
        />
      }
    />
  );
}

function Runs({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const runs = useApi(() => api.call("GET /orgs/:orgId/pay-runs", { params: { orgId } }), [orgId]);
  if (runs.loading) return <Skeleton lines={3} label="Loading pay runs" />;
  if (runs.error || !runs.data)
    return <ErrorNote error={runs.error ?? "No pay runs"} onRetry={runs.reload} />;
  const unsigned = runs.data.payRuns.filter((r) => UNSIGNED_RUN_STATUSES.includes(r.status));
  const owner = runs.data.payRuns.filter((r) => OWNER_RUN_STATUSES.includes(r.status));
  const next = unsigned[0];
  const ready = runs.data.payRuns.filter((r) => r.readyForReview);
  return (
    <>
      {ready.length > 0 ? (
        <div className="notice reminder" role="status">
          {ready.map((r) => (
            <p key={r.id}>
              The pay run for <strong>{r.period}</strong> was prepared automatically and is ready
              for review (payday {r.scheduledFor}). Nothing has been quoted or signed.{" "}
              <a href={`/app/pay-run?id=${r.id}`}>Review it</a>
            </p>
          ))}
        </div>
      ) : null}
      <div className="grid-3">
        <Card>
          <Stat
            label="Reserved for unsigned runs"
            value={<AmountText value={sumDecimals(unsigned.map((r) => r.totalAmount))} />}
            note={`${unsigned.length} run${unsigned.length === 1 ? "" : "s"} not yet signed`}
          />
        </Card>
        <Card>
          {next ? (
            <div className="stack">
              <Stat
                label="Next pay run"
                value={next.period}
                note={<RunTag status={next.status} />}
              />
              <ButtonLink href={`/app/pay-run?id=${next.id}`} variant="grey" small>
                Open {next.period}
              </ButtonLink>
            </div>
          ) : (
            <Stat label="Next pay run" value="None" note="Create one from Pay runs" />
          )}
        </Card>
        <Card>
          <div className="stack">
            <span className="stat-label">Needs the owner</span>
            {owner.length === 0 ? (
              <p className="muted">Nothing waiting.</p>
            ) : (
              <ul className="list-plain">
                {owner.map((r) => (
                  <li key={r.id}>
                    <a href={`/app/pay-run?id=${r.id}`}>{r.period}</a>
                    <RunTag status={r.status} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

export function TreasuryScreen() {
  return (
    <NeedsOrg>
      {(orgId) => (
        <>
          <PageHeader
            eyebrow="Treasury"
            title="Treasury home"
            actions={
              <ButtonLink href="/app/pay-runs" small>
                Pay runs
              </ButtonLink>
            }
          />
          <Card size="lg">
            <Balance orgId={orgId} />
          </Card>
          <Runs orgId={orgId} />
        </>
      )}
    </NeedsOrg>
  );
}
