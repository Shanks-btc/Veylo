"use client";
// Payee registry (slice W6): the list of people your company may pay, signed by your treasury wallet.
// Every version is kept. For each one you see who signed it and when, and you can check it in your
// own browser: the signatures, the set of payees and the treasury's own key are verified here, not
// taken from Veylo's server.
import type { payeeHistoryResponse } from "@veylo/contract";
import { useState } from "react";
import type { z } from "zod";
import { LoadBlock } from "../app-ui/page-kit";
import { NeedsOrg, PageHeader } from "../app-ui/shell";
import { useApi, useSession } from "../app-ui/session";
import { formatDate } from "../app-ui/format";
import { createMemoryHighWater } from "../gates";
import { parseCanonicalRecord, verifyRegistry } from "../gates/registry";
import { Button, Tag } from "../ui/basic";
import { Table } from "../ui/data";
import { AddressText, Card } from "../ui/interactive";

type Version = z.infer<typeof payeeHistoryResponse>["versions"][number];
type Verdict =
  { state: "checking" } | { state: "ok"; payees: number } | { state: "failed"; reason: string };

function Registry({ orgId }: { orgId: string }) {
  const { api, config, gateDeps } = useSession();
  const org = useApi(() => api.call("GET /orgs/:orgId", { params: { orgId } }), [orgId]);
  const history = useApi(
    () => api.call("GET /orgs/:orgId/payee-registry/history", { params: { orgId } }),
    [orgId],
  );
  const [verdicts, setVerdicts] = useState<Record<number, Verdict>>({});

  async function verify(v: Version, treasury: string) {
    const version = v.head?.version ?? 0;
    setVerdicts((cur) => ({ ...cur, [version]: { state: "checking" } }));
    try {
      const deps = await gateDeps();
      // Each version is checked as of the moment it was signed, with the treasury's real key on NEAR.
      const at = new Date(Date.parse(v.head?.signedAt ?? "") + 60_000);
      const r = await verifyRegistry({
        orgId,
        treasuryAccountId: treasury,
        authRecipient: deps.authRecipient || config.authRecipient,
        registry: v,
        rpc: deps.rpc,
        highWater: createMemoryHighWater(),
        now: Number.isNaN(at.getTime()) ? deps.now : at,
      });
      setVerdicts((cur) => ({
        ...cur,
        [version]: r.ok
          ? { state: "ok", payees: r.payees.length }
          : { state: "failed", reason: r.reason },
      }));
    } catch (err) {
      setVerdicts((cur) => ({
        ...cur,
        [version]: {
          state: "failed",
          reason: err instanceof Error ? err.message : "Couldn't check.",
        },
      }));
    }
  }

  return (
    <LoadBlock query={org} label="your organisation">
      {(o) => (
        <LoadBlock
          query={history}
          label="the payee registry"
          isEmpty={(d) => d.versions.length === 0}
          empty={{
            title: "No signed payee list yet",
            body: "When you approve a contractor's address with your treasury wallet, the signed list starts here.",
            icon: "shield",
            action: (
              <a className="btn btn-dark" href="/app/contractors">
                Go to contractors
              </a>
            ),
          }}
        >
          {(d) => {
            const [current] = d.versions;
            return (
              <div className="stack">
                {current?.head ? (
                  <Card className="stack">
                    <h2 className="section-title">Current list: version {current.head.version}</h2>
                    <dl className="kv">
                      <div className="kv-row">
                        <dt>Signed by</dt>
                        <dd>
                          <AddressText
                            value={current.head.signerAccountId}
                            label="signer account"
                          />
                        </dd>
                      </div>
                      <div className="kv-row">
                        <dt>Signed</dt>
                        <dd>{formatDate(current.head.signedAt)}</dd>
                      </div>
                      <div className="kv-row">
                        <dt>People on the list</dt>
                        <dd>{current.head.recordHashes.length}</dd>
                      </div>
                    </dl>
                    <Table
                      caption="Approved payees"
                      rows={current.approvals}
                      rowKey={(a) => a.id}
                      columns={[
                        { key: "name", label: "Contractor", render: (a) => a.contractorName },
                        {
                          key: "to",
                          label: "Pays to",
                          render: (a) => {
                            const r = parseCanonicalRecord(a.canonicalRecord);
                            return <span className="mono">{r ? r.recipient : "unreadable"}</span>;
                          },
                        },
                        { key: "ver", label: "Version", render: (a) => a.version },
                        { key: "at", label: "Approved", render: (a) => formatDate(a.approvedAt) },
                        { key: "exp", label: "Expires", render: (a) => formatDate(a.expiresAt) },
                      ]}
                    />
                  </Card>
                ) : null}

                <Card className="stack">
                  <h2 className="section-title">Every version</h2>
                  <p className="muted small">
                    Each change to the list is signed by your treasury wallet. &ldquo;Verify&rdquo;
                    checks the signatures and the treasury&apos;s key in your browser.
                  </p>
                  <Table
                    caption="Registry versions"
                    rows={d.versions}
                    rowKey={(v) => String(v.head?.version)}
                    columns={[
                      { key: "v", label: "Version", render: (v) => `v${v.head?.version}` },
                      {
                        key: "at",
                        label: "Signed",
                        render: (v) => (v.head ? formatDate(v.head.signedAt) : ""),
                      },
                      {
                        key: "by",
                        label: "Signed by",
                        render: (v) => (
                          <span className="mono">{v.head?.signerAccountId.slice(0, 12)}…</span>
                        ),
                      },
                      {
                        key: "n",
                        label: "People",
                        render: (v) => v.head?.recordHashes.length ?? 0,
                      },
                      {
                        key: "verify",
                        label: "Check",
                        render: (v) => {
                          const verdict = verdicts[v.head?.version ?? 0];
                          return verdict?.state === "ok" ? (
                            <Tag tone="success">
                              Verified, {verdict.payees} payee{verdict.payees === 1 ? "" : "s"}
                            </Tag>
                          ) : verdict?.state === "failed" ? (
                            <span className="stack">
                              <Tag tone="error">Failed</Tag>
                              <span className="small">{verdict.reason}</span>
                            </span>
                          ) : (
                            <Button
                              small
                              variant="grey"
                              disabled={verdict?.state === "checking"}
                              onClick={() => void verify(v, o.treasuryAccountId)}
                            >
                              {verdict?.state === "checking" ? "Checking…" : "Verify"}
                            </Button>
                          );
                        },
                      },
                    ]}
                  />
                </Card>
              </div>
            );
          }}
        </LoadBlock>
      )}
    </LoadBlock>
  );
}

export function PayeesScreen() {
  return (
    <>
      <PageHeader eyebrow="People" title="Payee registry">
        The people you may pay, signed by your treasury wallet.
      </PageHeader>
      <NeedsOrg>{(orgId) => <Registry orgId={orgId} />}</NeedsOrg>
    </>
  );
}
