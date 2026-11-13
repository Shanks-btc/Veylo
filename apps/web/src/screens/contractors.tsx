"use client";
// Screen 4: contractors, with each one's route (private or direct) and whether they're payable.
// The payable state is the API's view for display; the browser re-verifies it before any payout.
// Adding a contractor takes a name, a monthly USD rate and (optionally) the first payout address;
// nothing is payable until the treasury wallet approves that address on the contractor's page.
import { PAYOUT_ROUTES, ROUTE_AVAILABILITY, USDC, formatAmount, parseAmount } from "@veylo/core";
import type { contractor } from "@veylo/contract";
import { useState, type FormEvent } from "react";
import type { z } from "zod";
import { ApiError } from "../api/client";
import { Estimate } from "../app-ui/fx";
import { LoadBlock } from "../app-ui/page-kit";
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useApi, useOrg, useSession } from "../app-ui/session";
import { RouteTag } from "../app-ui/format";
import { Button, ButtonLink, Field, fieldAria, Tag } from "../ui/basic";
import { Table } from "../ui/data";
import { Modal, useToast } from "../ui/interactive";

type Contractor = z.infer<typeof contractor>;

/** NEAR-only scope: enabled routes, plus "Coming soon" ones shown but not selectable. */
const ROUTES = PAYOUT_ROUTES.filter((r) => ROUTE_AVAILABILITY[r.id] !== "disabled");
const FIRST_ENABLED = ROUTES.find((r) => ROUTE_AVAILABILITY[r.id] === "enabled")?.id ?? "";

/** A contractor's rate as USDC units (text) from the terms JSON, or null when it isn't readable. */
export function rateUnits(c: Pick<Contractor, "terms">): bigint | null {
  const rate = (c.terms as { rate?: unknown }).rate;
  if (typeof rate !== "string" || !/^[1-9]\d{0,18}$/.test(rate)) return null;
  return BigInt(rate);
}

function Payable({ orgId, c }: { orgId: string; c: Contractor }) {
  const { api } = useSession();
  const d = useApi(
    () =>
      api.call("GET /orgs/:orgId/contractors/:contractorId/destinations", {
        params: { orgId, contractorId: c.id },
      }),
    [orgId, c.id],
  );
  if (d.loading) return <span className="muted small">Checking…</span>;
  if (d.error || !d.data) return <span className="muted small">Unknown</span>;
  const active = d.data.destinations.find((x) => x.status === "active");
  if (!active) return <Tag tone="neutral">No address</Tag>;
  return active.payable ? (
    <Tag tone="success">Payable</Tag>
  ) : (
    <Tag tone="warning">{active.payableReason.replaceAll("_", " ")}</Tag>
  );
}

function AddContractor({
  orgId,
  open,
  onClose,
  onAdded,
}: {
  orgId: string;
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { api } = useSession();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [rate, setRate] = useState("");
  const [route, setRoute] = useState<string>(FIRST_ENABLED);
  const [address, setAddress] = useState("");
  const [errors, setErrors] = useState<
    Partial<Record<"name" | "email" | "rate" | "address" | "form", string>>
  >({});
  const [busy, setBusy] = useState(false);
  const chosen = ROUTES.find((r) => r.id === route);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Enter the person's name.";
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      next.email = "That doesn't look like an email address.";
    let units = 0n;
    try {
      units = parseAmount(rate.trim(), USDC).units;
      if (units <= 0n) throw new Error("zero");
    } catch {
      next.rate = "Enter the monthly pay in US dollars, for example 2500 or 2500.50.";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    let created: Contractor | undefined;
    try {
      created = await api.call("POST /orgs/:orgId/contractors", {
        params: { orgId },
        body: {
          name: name.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          terms: { kind: "fixed", rate: units.toString(), schedule: "monthly" },
        },
      });
      if (address.trim()) {
        await api.call("POST /orgs/:orgId/contractors/:contractorId/destinations", {
          params: { orgId, contractorId: created.id },
          body: { route, address: address.trim() },
        });
      }
      toast(
        "success",
        address.trim()
          ? "Contractor added. Approve their address with your treasury wallet to make it payable."
          : "Contractor added. Add their payout address next.",
      );
      setName("");
      setEmail("");
      setRate("");
      setAddress("");
      onAdded();
      onClose();
    } catch (err) {
      const why = err instanceof ApiError ? err.message : "Couldn't add the contractor. Try again.";
      if (created) {
        // The person exists; only the address failed. Send them to add it again rather than creating a duplicate.
        toast("error", `Contractor added, but the address was refused: ${why}`);
        window.location.assign(`/app/contractor/add-address?id=${created.id}`);
        return;
      }
      setErrors({ form: why });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Add a contractor"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="form" onSubmit={submit} noValidate id="add-contractor-form">
        <Field id="ac-name" label="Name" error={errors.name}>
          <input
            {...fieldAria("ac-name", undefined, errors.name)}
            value={name}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          id="ac-email"
          label="Email (optional)"
          hint="Used only to send their invitation."
          error={errors.email}
        >
          <input
            {...fieldAria("ac-email", "hint", errors.email)}
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoComplete="off"
            value={email}
            maxLength={320}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field
          id="ac-rate"
          label="Monthly pay (US dollars)"
          hint="Salaries are set in dollars and paid in USDC, or in NEAR if they choose it."
          error={errors.rate}
        >
          <input
            {...fieldAria("ac-rate", "hint", errors.rate)}
            inputMode="decimal"
            value={rate}
            maxLength={24}
            autoComplete="off"
            onChange={(e) => setRate(e.target.value)}
          />
        </Field>
        <Field id="ac-route" label="Payout route">
          <select id="ac-route" value={route} onChange={(e) => setRoute(e.target.value)}>
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
        <Field
          id="ac-address"
          label={
            chosen?.payoutMode === "private"
              ? "NEAR account (optional now)"
              : "Address (optional now)"
          }
          hint="Copy it from the contractor's own wallet. You can also add it later."
          error={errors.address}
        >
          <input
            {...fieldAria("ac-address", "hint", errors.address)}
            value={address}
            maxLength={128}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        {errors.form ? <ErrorNote error={errors.form} /> : null}
        <div className="sticky-actions">
          <Button type="submit" disabled={busy}>
            {busy ? "Adding…" : "Add contractor"}
          </Button>
          <Button variant="grey" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ContractorList({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const role = useOrg()?.role;
  const canAdd = role === "owner" || role === "preparer";
  const [adding, setAdding] = useState(false);
  const list = useApi(
    () => api.call("GET /orgs/:orgId/contractors", { params: { orgId } }),
    [orgId],
  );
  const settings = useApi(
    () => api.call("GET /orgs/:orgId/settings", { params: { orgId } }),
    [orgId],
  );
  const orgCurrency = settings.data?.displayCurrency ?? "USD";

  const actions = canAdd ? (
    <>
      <ButtonLink href="/app/contractors/import" variant="grey">
        Import CSV
      </ButtonLink>
      <Button onClick={() => setAdding(true)}>Add contractor</Button>
    </>
  ) : undefined;

  return (
    <>
      <PageHeader eyebrow="People" title="Contractors" actions={actions}>
        Each person chooses private or direct, both on NEAR.
      </PageHeader>
      <LoadBlock
        query={list}
        label="contractors"
        isEmpty={(d) => d.contractors.length === 0}
        empty={{
          title: "No contractors yet",
          body: "Add someone you pay. They'll appear here with their route and whether they're payable.",
          icon: "users",
          action: canAdd ? (
            <Button onClick={() => setAdding(true)}>Add your first contractor</Button>
          ) : undefined,
        }}
      >
        {(d) => (
          <Table
            caption="Contractors"
            rows={d.contractors}
            rowKey={(c) => c.id}
            columns={[
              {
                key: "name",
                label: "Name",
                render: (c) => <a href={`/app/contractor?id=${c.id}`}>{c.name}</a>,
              },
              {
                key: "rate",
                label: "Monthly pay",
                render: (c) => {
                  const units = rateUnits(c);
                  if (units === null) return <span className="muted small">Hidden</span>;
                  return (
                    <span className="stack">
                      <span className="mono">${formatAmount({ asset: USDC, units })}</span>
                      <Estimate usdUnits={units} currency={c.displayCurrency ?? orgCurrency} />
                    </span>
                  );
                },
              },
              { key: "route", label: "Route", render: (c) => <RouteTag mode={c.payoutMode} /> },
              {
                key: "status",
                label: "Status",
                render: (c) => <Tag tone="neutral">{c.status}</Tag>,
              },
              { key: "payable", label: "Payable", render: (c) => <Payable orgId={orgId} c={c} /> },
            ]}
          />
        )}
      </LoadBlock>
      <AddContractor
        orgId={orgId}
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={list.reload}
      />
    </>
  );
}

export function ContractorsScreen() {
  return <NeedsOrg>{(orgId) => <ContractorList orgId={orgId} />}</NeedsOrg>;
}
