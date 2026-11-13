"use client";
// Verify a payout (slice W5, C2): /verify?payout=<item id>. A direct payout is re-checked from NEAR
// on every load. A private payout shows what NEAR Intents recorded, and nothing more is claimed.
import { PAYOUT_ROUTES, parseAmount, USDC } from "@veylo/core";
import { useCallback, useEffect, useState } from "react";
import { verifyRegistry } from "../gates/registry";
import { createProofRpc } from "../proof/rpc";
import { privatePayoutFacts, verifyDirectPayout, type DirectVerification } from "../proof/verify";
import { PRIVACY_CONDITION } from "../site";
import { SessionProvider, useApi, useQueryParam, useSession, webConfig } from "../app-ui/session";
import { ErrorNote, PageHeader } from "../app-ui/shell";
import { AmountText, Button, ButtonLink, Logo, Skeleton, Tag } from "../ui/basic";
import { Card } from "../ui/card";
import { CheckList } from "../ui/data";
import { ToastProvider } from "../ui/interactive";

type Found = {
  payRunId: string;
  /** The route's id, from the ledger: the API's payslip only carries its label. */
  routeId: string | null;
  contractorId: string;
  contractorName: string;
};

function Verify() {
  const { api, me, orgId, gateDeps } = useSession();
  const payout = useQueryParam("payout");
  const [direct, setDirect] = useState<DirectVerification>();
  const [busy, setBusy] = useState(false);

  const slip = useApi(
    me && orgId && payout
      ? async () => {
          // The ledger lists payouts by item; walk a few pages to find this one.
          let cursor: string | undefined;
          for (let page = 0; page < 5; page += 1) {
            const l = await api.call("GET /orgs/:orgId/ledger", {
              params: { orgId },
              query: cursor ? { cursor } : {},
            });
            const hit = l.items.find((e) => e.kind === "payout" && e.itemId === payout);
            if (hit && hit.kind === "payout") {
              const found: Found = {
                payRunId: hit.payRunId,
                routeId: hit.route,
                contractorId: hit.contractor.id,
                contractorName: hit.contractor.name,
              };
              const payslip = await api.call(
                "GET /orgs/:orgId/pay-runs/:payRunId/items/:itemId/payslip",
                { params: { orgId, payRunId: found.payRunId, itemId: payout } },
              );
              return { found, payslip };
            }
            if (!l.nextCursor) break;
            cursor = l.nextCursor;
          }
          throw new Error("That payout isn't in this organisation's ledger.");
        }
      : undefined,
    [orgId, payout, me?.user.id],
  );

  const route = PAYOUT_ROUTES.find((r) => r.id === slip.data?.found.routeId);
  const isPrivate = route?.payoutMode === "private";

  const run = useCallback(async () => {
    const data = slip.data;
    if (!data || !orgId || isPrivate) return;
    setBusy(true);
    try {
      const org = await api.call("GET /orgs/:orgId", { params: { orgId } });
      const registry = await api.call("GET /orgs/:orgId/payee-registry", { params: { orgId } });
      const deps = await gateDeps();
      // The signed payee list, verified here: the treasury account is the organisation's.
      const verified = await verifyRegistry({
        orgId,
        treasuryAccountId: org.treasuryAccountId,
        authRecipient: deps.authRecipient,
        registry,
        rpc: deps.rpc,
        highWater: deps.highWater,
        now: deps.now,
      });
      const approved = verified.ok
        ? verified.payees.find((p) => p.record.contractorId === data.found.contractorId)?.record
            .recipient
        : undefined;
      const p = data.payslip;
      const rpc = createProofRpc({
        url: webConfig.nearArchivalRpcUrl,
        fetch: globalThis.fetch.bind(globalThis),
      });
      setDirect(
        await verifyDirectPayout({
          nearTxHashes: p.hashes.nearTxHashes,
          payslipRecipient: p.recipient ?? "",
          payslipAmountUnits: p.amount ? parseAmount(p.amount, USDC).units.toString() : "0",
          deliveryFeeUnits: p.deliveryFee ? parseAmount(p.deliveryFee, USDC).units.toString() : "0",
          approvedRecipient: approved,
          rpc,
          now: () => new Date(),
        }),
      );
    } catch {
      setDirect({
        status: "unavailable",
        checkedAt: new Date(),
        reason: "couldn't check right now",
      });
    } finally {
      setBusy(false);
    }
  }, [slip.data, orgId, isPrivate, api, gateDeps]);

  useEffect(() => {
    void run();
  }, [run]);

  if (me === null)
    return (
      <div className="stack">
        <PageHeader eyebrow="Verify" title="Verify a payout">
          Re-check a payout against NEAR, in your own browser.
        </PageHeader>
        <Card className="stack">
          <h2 className="section-title">Sign in to open this payout</h2>
          <p className="muted">
            A payout belongs to an organisation&apos;s ledger, so it opens for the people in that
            organisation. For a public payout, this page reads NEAR itself and checks the amount and
            the recipient. For a private payout it shows what NEAR Intents recorded, and nothing
            more is claimed.
          </p>
          <div className="actions">
            <ButtonLink href="/app/sign-in">Sign in</ButtonLink>
            <ButtonLink href="/docs#records" variant="grey">
              How verification works
            </ButtonLink>
          </div>
        </Card>
      </div>
    );
  if (payout === null)
    return (
      <div className="stack">
        <PageHeader eyebrow="Verify" title="Verify a payout">
          Re-check a payout against NEAR, in your own browser.
        </PageHeader>
        <ErrorNote error="No payout was chosen. Open the ledger, find the payout, and choose Verify." />
        <div className="actions">
          <ButtonLink href="/app/ledger">Open the ledger</ButtonLink>
        </div>
      </div>
    );
  if (slip.loading) return <Skeleton lines={4} label="Loading the payout" />;
  if (slip.error || !slip.data)
    return <ErrorNote error={slip.error ?? "Not found"} onRetry={slip.reload} />;
  const { payslip } = slip.data;

  return (
    <div className="stack">
      <PageHeader eyebrow="Verify" title={`Payout to ${slip.data.found.contractorName}`}>
        {payslip.period} · <AmountText value={payslip.amount} /> ·{" "}
        {isPrivate ? <Tag tone="private">Private</Tag> : <Tag tone="direct">Direct</Tag>}
      </PageHeader>
      {isPrivate ? (
        <Card>
          {(() => {
            const f = privatePayoutFacts({
              status: payslip.status,
              intentHash: payslip.hashes.intentHash,
              intentsExplorerUrl: payslip.links.intentsExplorer,
            });
            return (
              <div className="stack">
                <p>
                  Status recorded by NEAR Intents: <strong>{f.status}</strong>
                </p>
                <p>
                  Intent hash: <span className="mono">{f.intentHash ?? "not recorded"}</span>
                </p>
                {f.intentsExplorerUrl ? (
                  <a href={f.intentsExplorerUrl} target="_blank" rel="noopener noreferrer">
                    View on the NEAR Intents explorer
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : null}
                <p className="muted">{f.note}</p>
                <p className="notice notice-private small">{PRIVACY_CONDITION}</p>
              </div>
            );
          })()}
        </Card>
      ) : (
        <Card>
          {busy || !direct ? (
            <p role="status">Reading NEAR mainnet…</p>
          ) : direct.status === "unavailable" ? (
            <div className="stack" role="alert">
              <p>
                <strong>Couldn&apos;t check right now.</strong> {direct.reason}.
              </p>
              <Button variant="grey" small onClick={run}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="stack">
              <p>
                <strong>
                  {direct.status === "verified"
                    ? "Every check passed."
                    : "At least one check failed."}
                </strong>{" "}
                Checked at{" "}
                <time dateTime={direct.checkedAt.toISOString()}>
                  {direct.checkedAt.toISOString().replace("T", " ").slice(0, 19)} UTC
                </time>
                .
              </p>
              <CheckList
                label="Checks on this payout"
                items={direct.checks.map((c, i) => ({
                  id: String(i),
                  label: c.label,
                  state: c.ok ? "pass" : "fail",
                  reason: c.detail,
                }))}
              />
              <Button variant="grey" small onClick={run}>
                Check again
              </Button>
            </div>
          )}
        </Card>
      )}
      <ButtonLink href="/app/ledger" variant="grey" small>
        Back to the ledger
      </ButtonLink>
    </div>
  );
}

export function VerifyScreen() {
  return (
    <SessionProvider>
      <ToastProvider>
        <main id="main" className="verify-page wrap">
          <a className="verify-logo" href="/" aria-label="Veylo, home">
            <Logo />
          </a>
          <Verify />
        </main>
      </ToastProvider>
    </SessionProvider>
  );
}
