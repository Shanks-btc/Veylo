"use client";
// The contractor portal (slice W5, D3; completed in W6): join and sign in (/portal/accept) and see
// payments and payslips (/portal). The payout address and the balance have their own pages. A
// contractor sees only their own data; the API answers 404 for anyone else's.
import { DISPLAY_CURRENCIES, USDC, parseAmount } from "@veylo/core";
import { useState } from "react";
import { ApiError } from "../api/client";
import { Estimate, FxNote } from "../app-ui/fx";
import { formatDate, StateTag, sumDecimals } from "../app-ui/format";
import { Facts, LoadBlock } from "../app-ui/page-kit";
import { useApi, useQueryParam, useSession } from "../app-ui/session";
import { ErrorNote, PageHeader } from "../app-ui/shell";
import { downloadBytes } from "../reports/download";
import { portalPayslipPdf } from "../reports/documents";
import { AmountText, Button, Field, Skeleton, Stat } from "../ui/basic";
import { Table } from "../ui/data";
import { Card, useToast } from "../ui/interactive";
import { PortalGate, PortalPage, PortalSignIn, type PortalContractor } from "./portal-kit";

// ---- Page 1: invite and sign in ----

function Accept() {
  const { api, me } = useSession();
  const token = useQueryParam("token");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function join() {
    if (!token) return;
    setBusy(true);
    setError(undefined);
    try {
      const joined = await api.call("POST /portal/invites/accept", { body: { token } });
      // First time: they have no payout address yet, so that is the next step.
      const dests = await api.call("GET /portal/contractors/:contractorId/destinations", {
        params: { contractorId: joined.contractorId },
      });
      const next = dests.destinations.length === 0 ? "/portal/address" : "/portal";
      window.location.assign(`${next}?c=${joined.contractorId}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "INVITE_CLAIMED"
            ? "Someone has already joined with this invite. If that wasn't you, ask your organisation for a new one."
            : err.code === "INVITE_INVALID"
              ? "This invite link isn't valid any more. It may have expired or already been used. Ask your organisation for a new one."
              : err.message
          : "Couldn't use this invite. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (token === undefined || me === undefined)
    return <Skeleton lines={2} label="Loading your invite" />;
  if (token === null || token.length !== 43) {
    return (
      <Card size="lg" className="stack">
        <h1>This invite link is incomplete</h1>
        <ErrorNote error="The link is missing part of its code. Open the full link from your email, or ask your organisation to send it again." />
        <a className="btn btn-grey" href="/portal">
          Go to the portal
        </a>
      </Card>
    );
  }
  if (me === null) {
    return (
      <PortalSignIn
        next={`/portal/accept?token=${token}`}
        title="Join your organisation's payroll"
      />
    );
  }
  return (
    <Card size="lg" className="stack">
      <h1>Join your organisation&apos;s payroll</h1>
      <p className="muted">
        Accepting links your account to your contractor record, so you can see your own payments and
        payout address. The link works once.
      </p>
      <div className="sticky-actions">
        <Button onClick={() => void join()} disabled={busy}>
          {busy ? "Joining…" : "Accept the invite"}
        </Button>
      </div>
      {error ? <ErrorNote error={error} /> : null}
    </Card>
  );
}

export const PortalAcceptScreen = () => (
  <PortalPage active="/portal/accept">
    <Accept />
  </PortalPage>
);

// ---- Page 2: payments and payslips ----

function Payments({ c, reload }: { c: PortalContractor; reload: () => void }) {
  const { api } = useSession();
  const toast = useToast();
  const q = useApi(
    () =>
      api.call("GET /portal/contractors/:contractorId/payslips", {
        params: { contractorId: c.contractorId },
      }),
    [c.contractorId],
  );
  const shown = c.displayCurrency ?? c.orgDisplayCurrency;

  async function chooseCurrency(code: string) {
    try {
      await api.call("PATCH /portal/contractors/:contractorId/display-currency", {
        params: { contractorId: c.contractorId },
        body: { displayCurrency: code === "" ? null : code },
      });
      toast(
        "success",
        code === "" ? "Using your organisation's currency." : `Estimates will show in ${code}.`,
      );
      reload();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Couldn't change the currency.");
    }
  }

  return (
    <>
      <PageHeader eyebrow={c.orgName} title="Your payments">
        What {c.orgName} has paid {c.name}, with a payslip for each.
      </PageHeader>
      <LoadBlock
        query={q}
        label="your payments"
        isEmpty={(d) => d.payslips.length === 0}
        empty={{
          title: "No payments yet",
          body: "When you are paid, it appears here with a payslip. If you haven't added a payout address, do that first.",
          icon: "receipt",
          action: (
            <a className="btn btn-dark" href={`/portal/address?c=${c.contractorId}`}>
              Add payout address
            </a>
          ),
        }}
      >
        {(d) => {
          const paid = d.payslips.filter((p) => p.status === "SUCCESS");
          const last = paid[0];
          return (
            <div className="stack">
              <div className="grid-2">
                <Stat
                  label="Paid so far"
                  value={<AmountText value={sumDecimals(paid.map((p) => p.amount ?? "0"))} />}
                  note={`${paid.length} payment${paid.length === 1 ? "" : "s"}, in US dollar value`}
                />
                <Stat
                  label="Last payment"
                  value={last ? formatDate(last.at) : "None yet"}
                  note={last?.period}
                />
              </div>
              <Card className="stack">
                <div className="spread">
                  <h2 className="section-title">Payslips</h2>
                  <Field id="portal-currency" label="Show estimates in">
                    <select
                      id="portal-currency"
                      value={c.displayCurrency ?? ""}
                      onChange={(e) => void chooseCurrency(e.target.value)}
                    >
                      <option value="">Same as the organisation ({c.orgDisplayCurrency})</option>
                      {DISPLAY_CURRENCIES.map((x) => (
                        <option key={x.code} value={x.code}>
                          {x.code} · {x.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Table
                  caption="Your payslips"
                  rows={d.payslips}
                  rowKey={(p) => p.itemId}
                  columns={[
                    { key: "date", label: "Date", render: (p) => formatDate(p.at) },
                    { key: "period", label: "Period", render: (p) => p.period },
                    {
                      key: "paid",
                      label: "You received",
                      align: "right",
                      render: (p) => (
                        <span className="stack">
                          <AmountText value={p.paidAmount} currency={p.paidCurrency} />
                          {p.paidCurrency === "NEAR" ? (
                            <span className="small muted">
                              at {p.rate ?? "unknown"} USDC per NEAR
                              {p.quoteAsOf ? `, quoted ${formatDate(p.quoteAsOf)}` : ""}
                            </span>
                          ) : null}
                        </span>
                      ),
                    },
                    {
                      key: "usd",
                      label: "US dollar value",
                      align: "right",
                      render: (p) => {
                        let units: bigint | null = null;
                        try {
                          units = p.amount === null ? null : parseAmount(p.amount, USDC).units;
                        } catch {
                          units = null;
                        }
                        return (
                          <span className="stack">
                            <AmountText value={p.amount} currency="USD" />
                            <Estimate usdUnits={units} currency={shown} />
                          </span>
                        );
                      },
                    },
                    { key: "route", label: "Route", render: (p) => p.route ?? "—" },
                    {
                      key: "status",
                      label: "Status",
                      render: (p) => <StateTag status={p.status} />,
                    },
                    {
                      key: "slip",
                      label: "Payslip",
                      render: (p) => (
                        <span className="stack">
                          <Button
                            small
                            variant="grey"
                            onClick={() =>
                              downloadBytes(
                                portalPayslipPdf({
                                  company: c.orgName,
                                  contractorName: c.name,
                                  slip: p,
                                  appOrigin: window.location.origin,
                                }),
                                `payslip-${p.period}-${p.itemId.slice(0, 8)}.pdf`,
                              )
                            }
                          >
                            Download
                          </Button>
                          <a className="small" href={`/verify?payout=${p.itemId}`}>
                            Check this payout
                          </a>
                        </span>
                      ),
                    },
                  ]}
                />
                <FxNote currency={shown} />
              </Card>
              <Card size="sm">
                <Facts
                  rows={[
                    ["Paid by", c.orgName],
                    ["Your name on file", c.name],
                  ]}
                />
              </Card>
            </div>
          );
        }}
      </LoadBlock>
    </>
  );
}

export const PortalScreen = () => (
  <PortalPage active="/portal">
    <PortalGate next="/portal">{(c, reload) => <Payments c={c} reload={reload} />}</PortalGate>
  </PortalPage>
);
