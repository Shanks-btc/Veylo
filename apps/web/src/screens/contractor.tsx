"use client";
// Screen 5: one contractor, their payout addresses, and payee approval and revocation through the
// treasury wallet. Before the wallet signs, the browser verifies the current payee list itself and
// rebuilds both messages it is asked to sign (src/signing/payee-requests.ts).
import { useState } from "react";
import { DISPLAY_CURRENCIES, USDC, formatAmount } from "@veylo/core";
import type { destination } from "@veylo/contract";
import type { z } from "zod";
import { loadCurrentRegistry } from "../signing/current-registry";
import { checkApprovalRequest, checkRevokeRequest } from "../signing/payee-requests";
import { ApiError } from "../api/client";
import { Estimate, FxNote } from "../app-ui/fx";
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useApi, useQueryParam, useSession, webConfig, useOrg } from "../app-ui/session";
import { RouteTag, routeLabel } from "../app-ui/format";
import { Button, ButtonLink, EmptyState, Field, Skeleton, Tag } from "../ui/basic";
import { Table } from "../ui/data";
import { AddressText, Card, Modal, useToast } from "../ui/interactive";
import { rateUnits } from "./contractors";
import { PortalCard } from "./portal-owner";

type Destination = z.infer<typeof destination>;
type Pending =
  | { kind: "approve"; destination: Destination }
  | { kind: "revoke"; destination: Destination; approvalId: string };

function Detail({ orgId, contractorId }: { orgId: string; contractorId: string }) {
  const session = useSession();
  // Only the owner's treasury wallet approves or revokes payees (D2).
  const isOwner = useOrg()?.role === "owner";
  const { api, connectWallet, gateDeps } = session;
  const toast = useToast();
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const c = useApi(
    () =>
      api.call("GET /orgs/:orgId/contractors/:contractorId", { params: { orgId, contractorId } }),
    [orgId, contractorId],
  );
  const d = useApi(
    () =>
      api.call("GET /orgs/:orgId/contractors/:contractorId/destinations", {
        params: { orgId, contractorId },
      }),
    [orgId, contractorId],
  );
  const reg = useApi(
    () => api.call("GET /orgs/:orgId/payee-registry", { params: { orgId } }),
    [orgId],
  );

  const canEdit = useOrg()?.role === "owner" || useOrg()?.role === "preparer";
  const orgSettings = useApi(
    () => api.call("GET /orgs/:orgId/settings", { params: { orgId } }),
    [orgId],
  );

  async function chooseCurrency(code: string) {
    try {
      await api.call("PATCH /orgs/:orgId/contractors/:contractorId", {
        params: { orgId, contractorId },
        body: { displayCurrency: code === "" ? null : code },
      });
      toast(
        "success",
        code === "" ? "Using your organisation's currency." : `Estimates will show in ${code}.`,
      );
      c.reload();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Couldn't change the currency.");
    }
  }

  async function run(p: Pending) {
    if (!c.data) return;
    setBusy(true);
    setError(undefined);
    try {
      const wallet = await connectWallet();
      const deps = await gateDeps();
      const now = deps.now;
      const current = await loadCurrentRegistry({
        api,
        orgId,
        treasuryAccountId: wallet.accountId,
        authRecipient: deps.authRecipient,
        now,
        rpc: deps.rpc,
        highWater: deps.highWater,
      });
      const sign = async (message: string, nonce: Uint8Array, recipient: string) => {
        const s = await wallet.signer.signMessage({ message, nonce, recipient });
        if (s.accountId !== wallet.accountId)
          throw new Error("the wallet signed as another account");
        return s;
      };
      if (p.kind === "approve") {
        const req = await api.call(
          "POST /orgs/:orgId/contractors/:contractorId/destinations/:destinationId/approval-request",
          { params: { orgId, contractorId, destinationId: p.destination.id } },
        );
        const ok = checkApprovalRequest(req, {
          orgId,
          authRecipient: deps.authRecipient,
          contractor: { id: c.data.id, name: c.data.name },
          destination: p.destination,
          current,
          now: session.now(),
        });
        const approval = await sign(req.approvalMessage, ok.approvalNonce, req.recipient);
        const head = await sign(req.headMessage, ok.headNonce, req.recipient);
        if (approval.publicKey !== head.publicKey) throw new Error("the wallet switched keys");
        await api.call(
          "POST /orgs/:orgId/contractors/:contractorId/destinations/:destinationId/approval-request/:requestId/complete",
          {
            params: {
              orgId,
              contractorId,
              destinationId: p.destination.id,
              requestId: req.requestId,
            },
            body: {
              accountId: approval.accountId,
              publicKey: approval.publicKey,
              approvalSignature: approval.signature,
              headSignature: head.signature,
            },
          },
        );
        toast("success", "Payee approved and signed onto the payee list.");
      } else {
        const req = await api.call("POST /orgs/:orgId/payees/:approvalId/revoke-request", {
          params: { orgId, approvalId: p.approvalId },
        });
        const ok = checkRevokeRequest(req, {
          orgId,
          authRecipient: deps.authRecipient,
          approvalId: p.approvalId,
          current,
          now: session.now(),
        });
        const head = await sign(req.headMessage, ok.headNonce, req.recipient);
        await api.call("POST /orgs/:orgId/payees/:approvalId/revoke-request/:requestId/complete", {
          params: { orgId, approvalId: p.approvalId, requestId: req.requestId },
          body: {
            accountId: head.accountId,
            publicKey: head.publicKey,
            headSignature: head.signature,
          },
        });
        toast("success", "Approval revoked. The payee list no longer includes it.");
      }
      setPending(undefined);
      d.reload();
      reg.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signing failed");
    } finally {
      setBusy(false);
    }
  }

  if (c.loading || d.loading) return <Skeleton lines={4} label="Loading contractor" />;
  if (c.error || !c.data) return <ErrorNote error={c.error ?? "Not found"} onRetry={c.reload} />;
  const approvalFor = (destId: string) =>
    reg.data?.approvals.find((a) => a.destinationId === destId)?.id;
  const rows = d.data?.destinations ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Contractor"
        title={c.data.name}
        actions={
          <ButtonLink href={`/app/contractor/add-address?id=${contractorId}`} small>
            Add payout address
          </ButtonLink>
        }
      >
        {c.data.email ?? "No email"} · <RouteTag mode={c.data.payoutMode} />
      </PageHeader>
      <Card className="stack">
        <h2 className="section-title">Pay and display currency</h2>
        {(() => {
          const units = rateUnits(c.data);
          const shown = c.data.displayCurrency ?? orgSettings.data?.displayCurrency ?? "USD";
          return (
            <>
              <p>
                {units === null ? (
                  <span className="muted">Pay terms are hidden for your role.</span>
                ) : (
                  <>
                    <span className="mono">${formatAmount({ asset: USDC, units })}</span> a month,
                    set in US dollars. <Estimate usdUnits={units} currency={shown} />
                  </>
                )}
              </p>
              {canEdit ? (
                <Field
                  id="cd-currency"
                  label="Show estimates in"
                  hint="For reading only. It never changes what is paid."
                >
                  <select
                    id="cd-currency"
                    value={c.data.displayCurrency ?? ""}
                    onChange={(e) => void chooseCurrency(e.target.value)}
                  >
                    <option value="">
                      Same as the organisation ({orgSettings.data?.displayCurrency ?? "USD"})
                    </option>
                    {DISPLAY_CURRENCIES.map((x) => (
                      <option key={x.code} value={x.code}>
                        {x.code} · {x.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <FxNote currency={shown} />
            </>
          );
        })()}
      </Card>
      {d.error ? <ErrorNote error={d.error} onRetry={d.reload} /> : null}
      {rows.length === 0 ? (
        <EmptyState title="No payout address" icon="wallet">
          Add the address this person is paid to. Your treasury wallet then signs it onto the payee
          list.
        </EmptyState>
      ) : (
        <Table
          caption="Payout addresses"
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            {
              key: "route",
              label: "Route",
              render: (r) => <RouteTag mode={r.payoutMode} routeId={r.route} />,
            },
            { key: "address", label: "Address", render: (r) => <AddressText value={r.address} /> },
            { key: "status", label: "Status", render: (r) => <Tag tone="neutral">{r.status}</Tag> },
            {
              key: "payable",
              label: "Payable",
              render: (r) =>
                r.payable ? (
                  <Tag tone="success">Payable</Tag>
                ) : (
                  <span className="small muted">{r.payableReason.replaceAll("_", " ")}</span>
                ),
            },
            {
              key: "action",
              label: "Treasury wallet",
              render: (r) => {
                if (!isOwner) return <span className="small muted">Owner only</span>;
                const approvalId = approvalFor(r.id);
                if (r.status === "active" && r.check.status === "accepted" && !r.payable)
                  return (
                    <Button small onClick={() => setPending({ kind: "approve", destination: r })}>
                      Approve
                    </Button>
                  );
                if (approvalId && r.payable)
                  return (
                    <Button
                      small
                      variant="grey"
                      onClick={() => setPending({ kind: "revoke", destination: r, approvalId })}
                    >
                      Revoke
                    </Button>
                  );
                return <span className="small muted">—</span>;
              },
            },
          ]}
        />
      )}
      <PortalCard orgId={orgId} contractorId={contractorId} isOwner={isOwner} />
      <Card size="sm">
        <p className="small muted">
          Only your treasury wallet can change who gets paid. Before it signs, this browser checks
          the current signed payee list on NEAR and rebuilds the exact message, so a changed address
          or a dropped payee is refused.
        </p>
      </Card>
      <Modal
        open={pending !== undefined}
        title={pending?.kind === "revoke" ? "Revoke this payee?" : "Approve this payee?"}
        onClose={() => {
          if (!busy) setPending(undefined);
        }}
        actions={
          <Button onClick={() => pending && run(pending)} disabled={busy}>
            {busy ? "Waiting for your wallet…" : "Sign with treasury wallet"}
          </Button>
        }
      >
        {pending ? (
          <div className="stack">
            <p>
              {c.data.name} · {routeLabel(pending.destination.route)}
            </p>
            <AddressText value={pending.destination.address} />
            <p className="small muted">
              {pending.kind === "approve"
                ? "Your wallet signs two messages: the approval, then the new payee list."
                : "Your wallet signs one message: the payee list without this address."}
            </p>
            {error ? <ErrorNote error={error} /> : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}

export function ContractorScreen() {
  const id = useQueryParam("id");
  return (
    <NeedsOrg>
      {(orgId) =>
        id === undefined ? (
          <Skeleton lines={3} />
        ) : id === null ? (
          <ErrorNote error="No contractor chosen." />
        ) : (
          <Detail orgId={orgId} contractorId={id} />
        )
      }
    </NeedsOrg>
  );
}
