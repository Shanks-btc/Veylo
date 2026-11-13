"use client";
// Screen 3: treasury home. Balance (read live by the API from NEAR), what unsigned runs reserve,
// the next pay run, and what waits on the owner.
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useApi, useOrg, useSession } from "../app-ui/session";
import { PrivateSessionButton } from "../app-ui/private-session";
import {
  OWNER_RUN_STATUSES,
  RunTag,
  sumDecimals,
  UNSIGNED_RUN_STATUSES,
  unitsToDecimal,
} from "../app-ui/format";
import { AmountText, ButtonLink, Skeleton, Stat, Tag } from "../ui/basic";
import { Card } from "../ui/interactive";

/** Plain words for why a balance can't be shown. */
export function whyUnavailable(reason: string): string {
  if (reason === "needs_session") return "Needs a one-time read-only connection from your wallet";
  if (reason === "oneclick_error") return "NEAR Intents didn't answer. Try again in a moment";
  if (reason === "rpc_error") return "NEAR didn't answer. Try again in a moment";
  return "Not available right now";
}

function Balance({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const isOwner = useOrg()?.role === "owner";
  const b = useApi(
    () => api.call("GET /orgs/:orgId/treasury/balances", { params: { orgId } }),
    [orgId],
  );
  if (b.loading) return <Skeleton lines={2} label="Loading balances" />;
  if (b.error || !b.data) return <ErrorNote error={b.error ?? "No balance"} onRetry={b.reload} />;
  const { confidential, public: pub } = b.data;
  return (
    <div className="stack">
      {!confidential.available && confidential.unavailable === "needs_session" && isOwner ? (
        <Card className="stack">
          <h2 className="section-title">See your private balance</h2>
          <PrivateSessionButton kind={{ type: "treasury", orgId }} onOpened={b.reload} />
        </Card>
      ) : null}
      <div className="grid-2">
        <Stat
          label="Private balance"
          value={
            confidential.available ? (
              <AmountText value={unitsToDecimal(confidential.amount)} />
            ) : (
              "Unavailable"
            )
          }
          note={
            confidential.available ? (
              <>
                <Tag tone="private">Private</Tag> confidential on NEAR Intents
              </>
            ) : (
              whyUnavailable(confidential.unavailable)
            )
          }
        />
        <Stat
          label="Public balance"
          value={pub.available ? <AmountText value={unitsToDecimal(pub.amount)} /> : "Unavailable"}
          note={pub.available ? "Visible on NEAR Intents" : whyUnavailable(pub.unavailable)}
        />
      </div>
    </div>
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
