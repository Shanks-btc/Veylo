"use client";
// Screen 12: add a contractor's payout address. The API validates and checks it; nothing is payable
// until the treasury wallet approves it on the contractor's page.
import { useState, type FormEvent } from "react";
import { PAYOUT_ROUTES, ROUTE_AVAILABILITY } from "@veylo/core";

import { ApiError } from "../api/client";
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useQueryParam, useSession } from "../app-ui/session";
import { Button, Field, fieldAria, Skeleton } from "../ui/basic";
import { Card, useToast } from "../ui/interactive";

/** NEAR-only scope (L46): enabled routes, plus "Coming soon" ones shown but not selectable. */
const ROUTES = PAYOUT_ROUTES.filter((r) => ROUTE_AVAILABILITY[r.id] !== "disabled");
const FIRST_ENABLED = ROUTES.find((r) => ROUTE_AVAILABILITY[r.id] === "enabled")?.id ?? "";

const PRIVACY_NOTE =
  "Private means no public source we checked links a confidential payout to the company, provided the payout address has never received a public payment from it.";

function Form({ orgId, contractorId }: { orgId: string; contractorId: string }) {
  const { api } = useSession();
  const toast = useToast();
  const [route, setRoute] = useState<string>(FIRST_ENABLED);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const chosen = ROUTES.find((r) => r.id === route);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!address.trim()) {
      setError("Enter the payout address.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.call("POST /orgs/:orgId/contractors/:contractorId/destinations", {
        params: { orgId, contractorId },
        body: { route, address: address.trim() },
      });
      toast("success", "Address added. Approve it with the treasury wallet to make it payable.");
      window.location.assign(`/app/contractor?id=${contractorId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add the address.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="Contractor" title="Add a payout address">
        One address per route. It isn&apos;t payable until your treasury wallet signs it onto the
        payee list.
      </PageHeader>
      <Card>
        <form className="form" onSubmit={onSubmit} noValidate>
          <Field id="route" label="Payout route">
            <select id="route" value={route} onChange={(e) => setRoute(e.target.value)}>
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
            id="address"
            label={chosen?.payoutMode === "private" ? "NEAR account" : "Address"}
            hint="Copy it from the contractor's own wallet. It can't be edited later."
            error={error}
          >
            <input
              {...fieldAria("address", "hint", error)}
              value={address}
              maxLength={128}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              onChange={(e) => setAddress(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add address"}
          </Button>
        </form>
      </Card>
    </>
  );
}

export function AddAddressScreen() {
  const id = useQueryParam("id");
  return (
    <NeedsOrg>
      {(orgId) =>
        id === undefined ? (
          <Skeleton lines={3} />
        ) : id === null ? (
          <ErrorNote error="No contractor chosen." />
        ) : (
          <Form orgId={orgId} contractorId={id} />
        )
      }
    </NeedsOrg>
  );
}
