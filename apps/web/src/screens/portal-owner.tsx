"use client";
// The owner's side of the contractor portal (slice W5, D3), on a contractor's page: make an invite
// link (shown once), and see address changes the contractor asked for. A new address can't be
// applied for 24 hours, and until it is the old one keeps working.
import { useState } from "react";
import { ApiError } from "../api/client";
import { useApi, useSession } from "../app-ui/session";
import { Button, Skeleton } from "../ui/basic";
import { AddressText, Card, useToast } from "../ui/interactive";

const when = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

export function PortalCard({
  orgId,
  contractorId,
  isOwner,
}: {
  orgId: string;
  contractorId: string;
  isOwner: boolean;
}) {
  const { api } = useSession();
  const toast = useToast();
  const [link, setLink] = useState<string>();
  const [busy, setBusy] = useState(false);
  const changes = useApi(
    () =>
      api.call("GET /orgs/:orgId/contractors/:contractorId/address-changes", {
        params: { orgId, contractorId },
      }),
    [orgId, contractorId],
  );

  async function invite() {
    setBusy(true);
    try {
      const r = await api.call("POST /orgs/:orgId/contractors/:contractorId/invites", {
        params: { orgId, contractorId },
      });
      setLink(`${window.location.origin}/portal/accept?token=${r.token}`);
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Couldn't make an invite.");
    } finally {
      setBusy(false);
    }
  }

  async function apply(requestId: string) {
    setBusy(true);
    try {
      await api.call(
        "POST /orgs/:orgId/contractors/:contractorId/address-changes/:requestId/apply",
        { params: { orgId, contractorId, requestId } },
      );
      toast("success", "Applied. Approve the new address with your treasury wallet to pay it.");
      changes.reload();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Couldn't apply it.");
    } finally {
      setBusy(false);
    }
  }

  const pending = changes.data?.changes.filter((c) => !c.applied) ?? [];
  return (
    <Card size="sm" className="stack">
      <h2 className="section-title">Contractor portal</h2>
      {changes.loading ? <Skeleton lines={1} /> : null}
      {pending.map((c) => (
        <div key={c.id} className="notice" role="alert">
          <p>
            <strong>This contractor asked to change their payout address.</strong> Check it with
            them first: a changed address is how payouts get redirected.
          </p>
          <p className="row">
            New address: <AddressText value={c.address} label="new address" />
          </p>
          <p className="small">
            {c.canApply
              ? "The 24-hour wait is over. Applying it makes it the contractor's address, and your treasury wallet still has to approve it before anyone is paid to it."
              : `You can apply it after ${when(c.appliesAfter)}. Until then their current address keeps working.`}
          </p>
          {isOwner ? (
            <Button small disabled={!c.canApply || busy} onClick={() => apply(c.id)}>
              {c.canApply ? "Apply the new address" : "Waiting 24 hours"}
            </Button>
          ) : null}
        </div>
      ))}
      {isOwner ? (
        <>
          <p className="small muted">
            An invite link lets this contractor sign in with their NEAR wallet to see their own
            payslips and ask to change their address. It works once and expires in 7 days.
          </p>
          <Button variant="grey" small onClick={invite} disabled={busy}>
            Make an invite link
          </Button>
          {link ? (
            <div className="stack" role="status">
              <p className="small">Copy it now: it isn&apos;t shown again.</p>
              <AddressText value={link} label="invite link" />
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
