"use client";
// Portal page 3 (slice W6): add or change the payout address. A contractor asks; nothing changes for
// 24 hours, and then only the organisation's owner can apply it with their treasury wallet. Until
// then the current address keeps working, and the owner sees a warning about the change.
import { PAYOUT_ROUTES, ROUTE_AVAILABILITY } from "@veylo/core";
import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { Saved, LoadBlock } from "../app-ui/page-kit";
import { useApi, useSession } from "../app-ui/session";
import { PageHeader } from "../app-ui/shell";
import { Button, Field, fieldAria, Tag } from "../ui/basic";
import { Table } from "../ui/data";
import { AddressText, Card, useToast } from "../ui/interactive";
import { PortalGate, PortalPage, type PortalContractor } from "./portal-kit";

/** Enabled routes, plus "coming soon" ones shown but not selectable. */
const ROUTES = PAYOUT_ROUTES.filter((r) => ROUTE_AVAILABILITY[r.id] !== "disabled");
const FIRST_ENABLED = ROUTES.find((r) => ROUTE_AVAILABILITY[r.id] === "enabled")?.id ?? "";
const PRIVACY_NOTE =
  "Private means no public source we checked links a confidential payout to the company, provided the payout address has never received a public payment from it.";
const when = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

function Address({ c }: { c: PortalContractor }) {
  const { api } = useSession();
  const toast = useToast();
  const params = { contractorId: c.contractorId };
  const dests = useApi(
    () => api.call("GET /portal/contractors/:contractorId/destinations", { params }),
    [c.contractorId],
  );
  const changes = useApi(
    () => api.call("GET /portal/contractors/:contractorId/address-changes", { params }),
    [c.contractorId],
  );
  const [route, setRoute] = useState<string>(FIRST_ENABLED);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string>();
  const chosen = ROUTES.find((r) => r.id === route);
  const hasAddress = (dests.data?.destinations.length ?? 0) > 0;

  async function request(e: FormEvent) {
    e.preventDefault();
    setSent(undefined);
    if (!address.trim()) return setError("Enter the NEAR account you want to be paid to.");
    setBusy(true);
    setError(undefined);
    try {
      const made = await api.call("POST /portal/contractors/:contractorId/address-change", {
        params,
        body: { route, address: address.trim() },
      });
      toast("success", "Request sent.");
      setSent(made.appliesAfter);
      setAddress("");
      changes.reload();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "ACCOUNT_NOT_FOUND"
            ? "That account doesn't exist on NEAR. Check the spelling, or create it in your wallet first."
            : err.code === "NEAR_UNAVAILABLE"
              ? "Couldn't check that account right now. Try again in a minute."
              : err.message
          : "Couldn't send the request. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow={c.orgName} title="Your payout address">
        Where {c.orgName} sends your pay. Each address is approved by their treasury wallet before
        it can be used.
      </PageHeader>

      <LoadBlock
        query={dests}
        label="your payout address"
        isEmpty={(d) => d.destinations.length === 0}
        empty={{
          title: "You have no payout address yet",
          body: "Add the NEAR account you want to be paid to below. Your organisation approves it, and then you can be paid.",
          icon: "wallet",
        }}
      >
        {(d) => (
          <Card className="stack">
            <h2 className="section-title">Current address</h2>
            <Table
              caption="Your payout addresses"
              rows={d.destinations}
              rowKey={(x) => x.id}
              columns={[
                {
                  key: "route",
                  label: "Route",
                  render: (x) => PAYOUT_ROUTES.find((r) => r.id === x.route)?.label ?? x.route,
                },
                {
                  key: "address",
                  label: "Address",
                  render: (x) => <AddressText value={x.address} label="payout address" />,
                },
                {
                  key: "status",
                  label: "Status",
                  render: (x) => (
                    <Tag tone={x.status === "active" ? "success" : "neutral"}>{x.status}</Tag>
                  ),
                },
              ]}
            />
          </Card>
        )}
      </LoadBlock>

      {changes.data?.changes
        .filter((x) => !x.applied)
        .map((x) => (
          <p key={x.id} className="notice" role="status">
            Change to <span className="mono">{x.address}</span> requested. {c.orgName} can apply it
            after <time dateTime={x.appliesAfter}>{when(x.appliesAfter)}</time>.
            {hasAddress ? " Until then your current address keeps working." : ""}
          </p>
        ))}

      <Card>
        <form className="form" onSubmit={request} noValidate>
          <h2 className="section-title">
            {hasAddress ? "Ask to change my address" : "Add my payout address"}
          </h2>
          <Field id="pa-route" label="How you want to be paid">
            <select id="pa-route" value={route} onChange={(e) => setRoute(e.target.value)}>
              {ROUTES.map((r) => {
                const soon = ROUTE_AVAILABILITY[r.id] !== "enabled";
                return (
                  <option key={r.id} value={r.id} disabled={soon}>
                    {r.payoutMode === "private" ? "Private" : "Direct"} · {r.label}
                    {soon ? " (coming soon)" : ""}
                  </option>
                );
              })}
            </select>
          </Field>
          {chosen?.payoutMode === "private" ? (
            <p className="notice notice-private">{PRIVACY_NOTE}</p>
          ) : (
            <p className="notice">Direct payouts are visible on the NEAR explorer.</p>
          )}
          <Field
            id="pa-address"
            label="NEAR account"
            hint="Copy it from your own wallet. A change waits 24 hours before it can be applied."
            error={error}
          >
            <input
              {...fieldAria("pa-address", "hint", error)}
              value={address}
              maxLength={128}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              onChange={(e) => setAddress(e.target.value)}
            />
          </Field>
          <div className="sticky-actions">
            <Button type="submit" disabled={busy}>
              {busy ? "Sending…" : hasAddress ? "Ask to change my address" : "Send my address"}
            </Button>
          </div>
          {sent ? (
            <Saved>
              Request sent. {c.orgName} can apply it after <time dateTime={sent}>{when(sent)}</time>
              , then approve it with their treasury wallet.
            </Saved>
          ) : null}
        </form>
      </Card>
    </>
  );
}

export const PortalAddress = () => (
  <PortalPage active="/portal/address">
    <PortalGate next="/portal/address">{(c) => <Address c={c} />}</PortalGate>
  </PortalPage>
);
