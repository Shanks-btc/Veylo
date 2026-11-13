"use client";
// Settings (slice W6): the organisation's profile, the currency its estimates show in, its time zone,
// notices (stored now, delivered when a mail provider is switched on), and security: your email,
// your wallet, your recovery phrase and your password. Display choices never reach an amount or a
// signature; the wallet's secrets never leave the wallet page.
import { DISPLAY_CURRENCIES } from "@veylo/core";
import { useMemo, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { FxNote } from "../app-ui/fx";
import { Facts, LoadBlock, Saved } from "../app-ui/page-kit";
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useApi, useOrg, useSession } from "../app-ui/session";
import { EMBEDDED_ID } from "../wallet/registry";
import { Button, Field, fieldAria, Tag } from "../ui/basic";
import { AddressText, Card, useToast } from "../ui/interactive";

const COMMON_ZONES = [
  "UTC",
  "Africa/Lagos",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Manila",
  "Asia/Singapore",
  "America/New_York",
  "America/Sao_Paulo",
  "America/Mexico_City",
  "Australia/Sydney",
];

function zones(): string[] {
  try {
    const all = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    if (all && all.length > 0) return ["UTC", ...all.filter((z) => z !== "UTC")];
  } catch {
    // Fall through to the short list.
  }
  return COMMON_ZONES;
}

function Profile({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const { api } = useSession();
  const toast = useToast();
  const q = useApi(() => api.call("GET /orgs/:orgId/settings", { params: { orgId } }), [orgId]);
  const list = useMemo(zones, []);
  const [form, setForm] = useState<{ name: string; displayCurrency: string; timeZone: string }>();
  const [prefs, setPrefs] = useState<{
    payrollReady: boolean;
    payoutSettled: boolean;
    weeklySummary: boolean;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const base = q.data;
    if (!base) return;
    const body = {
      name: (form?.name ?? base.name).trim(),
      displayCurrency: form?.displayCurrency ?? base.displayCurrency,
      timeZone: form?.timeZone ?? base.timeZone,
      notifications: prefs ?? base.notifications,
    };
    if (!body.name) return setError("Enter the organisation's name.");
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await api.call("PATCH /orgs/:orgId/settings", { params: { orgId }, body });
      setSaved(true);
      toast("success", "Settings saved.");
      q.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the settings. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoadBlock query={q} label="settings" lines={4}>
      {(s) => {
        const f = form ?? {
          name: s.name,
          displayCurrency: s.displayCurrency,
          timeZone: s.timeZone,
        };
        const n = prefs ?? s.notifications;
        return (
          <form className="stack" onSubmit={save} noValidate>
            <Card className="stack">
              <h2 className="section-title">Organisation</h2>
              <Field id="s-name" label="Name" error={error}>
                <input
                  {...fieldAria("s-name", undefined, error)}
                  value={f.name}
                  maxLength={200}
                  disabled={!canEdit}
                  onChange={(e) => setForm({ ...f, name: e.target.value })}
                />
              </Field>
              <div className="form-row">
                <Field
                  id="s-currency"
                  label="Show estimates in"
                  hint="Beside USD, as a rough guide only. Payouts are in USD terms."
                >
                  <select
                    id="s-currency"
                    value={f.displayCurrency}
                    disabled={!canEdit}
                    onChange={(e) => setForm({ ...f, displayCurrency: e.target.value })}
                    aria-describedby="s-currency-hint"
                  >
                    {DISPLAY_CURRENCIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} · {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  id="s-zone"
                  label="Time zone"
                  hint="Pay runs prepare on dates in this time zone."
                >
                  <select
                    id="s-zone"
                    value={f.timeZone}
                    disabled={!canEdit}
                    onChange={(e) => setForm({ ...f, timeZone: e.target.value })}
                  >
                    {list.map((z) => (
                      <option key={z} value={z}>
                        {z}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <FxNote currency={f.displayCurrency} />
              <Facts
                rows={[
                  [
                    "Treasury account",
                    <AddressText key="t" value={s.treasuryAccountId} label="treasury account" />,
                  ],
                ]}
              />
            </Card>
            <Card className="stack">
              <h2 className="section-title">Notices</h2>
              <p className="muted small">
                Choose what you want to hear about. Emails go out once your administrator switches
                on a mail provider; until then you see the same notices inside Veylo.
              </p>
              {(
                [
                  ["payrollReady", "A pay run is ready for my review"],
                  ["payoutSettled", "A payout settled or failed"],
                  ["weeklySummary", "A weekly summary"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="ack">
                  <input
                    type="checkbox"
                    checked={n[key]}
                    disabled={!canEdit}
                    onChange={(e) => setPrefs({ ...n, [key]: e.target.checked })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </Card>
            {canEdit ? (
              <div className="sticky-actions">
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Save settings"}
                </Button>
              </div>
            ) : (
              <p className="muted small">Only an owner can change these settings.</p>
            )}
            {saved ? <Saved>Saved.</Saved> : null}
            {error && !/name/i.test(error) ? <ErrorNote error={error} /> : null}
          </form>
        );
      }}
    </LoadBlock>
  );
}

function Security() {
  const { api, me, wallet, connectWallet, refreshMe } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [pwError, setPwError] = useState<string>();
  if (!me) return null;

  async function manage(action: "export" | "addPasskey") {
    setBusy(true);
    try {
      const w = wallet ?? (await connectWallet(EMBEDDED_ID));
      if (!w.signer.manage)
        throw new Error("This wallet is not a Veylo wallet, so it keeps its own backup.");
      await w.signer.manage(action);
      toast("success", action === "export" ? "Your recovery phrase was shown." : "Passkey added.");
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Couldn't open the wallet.");
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwError(undefined);
    try {
      await api.call("POST /auth/change-password", {
        body: { currentPassword: current, newPassword: next },
      });
      toast("success", "Password changed. Other devices were signed out.");
      setCurrent("");
      setNext("");
    } catch (err) {
      setPwError(
        err instanceof ApiError
          ? err.status === 401
            ? "That isn't your current password."
            : err.message
          : "Couldn't change the password.",
      );
    }
  }

  async function resend() {
    try {
      await api.call("POST /auth/resend-verification", { body: {} });
      toast("success", "We sent you a new confirmation link.");
      void refreshMe();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Couldn't send the link.");
    }
  }

  return (
    <div className="stack">
      <Card className="stack">
        <h2 className="section-title">Your account</h2>
        <Facts
          rows={[
            [
              "Email",
              me.user.email ? (
                <span key="e">
                  {me.user.email}{" "}
                  {me.user.emailVerified ? (
                    <Tag tone="success">Confirmed</Tag>
                  ) : (
                    <Tag tone="warning">Not confirmed</Tag>
                  )}
                </span>
              ) : (
                "None. You sign in with a wallet."
              ),
            ],
            [
              "Wallet account",
              me.user.nearAccountId ? (
                <AddressText key="w" value={me.user.nearAccountId} label="wallet account" />
              ) : (
                "No wallet linked yet"
              ),
            ],
          ]}
        />
        {me.user.email && !me.user.emailVerified ? (
          <Button variant="grey" small onClick={resend}>
            Send me a new confirmation link
          </Button>
        ) : null}
        <p className="small muted">
          Your email is for signing in and notices. It can&apos;t sign or approve payments. Your
          wallet does that.
        </p>
      </Card>

      <Card className="stack">
        <h2 className="section-title">Your wallet</h2>
        <p className="muted">
          Only you hold the key. If you lose this device and your recovery phrase, Veylo can&apos;t
          recover it.
        </p>
        <div className="actions">
          <Button variant="grey" disabled={busy} onClick={() => manage("export")}>
            Back up my recovery phrase
          </Button>
          <Button variant="grey" disabled={busy} onClick={() => manage("addPasskey")}>
            Add another passkey
          </Button>
        </div>
        <p className="small muted">
          These open your Veylo wallet. A wallet from another provider keeps its own backup.
        </p>
      </Card>

      {me.user.email ? (
        <Card>
          <form className="form" onSubmit={changePassword} noValidate>
            <h2 className="section-title">Change your email password</h2>
            <p className="muted small">
              This is not your wallet password. Changing it signs you out everywhere else.
            </p>
            <div className="form-row">
              <Field id="pw-current" label="Current password" error={pwError}>
                <input
                  {...fieldAria("pw-current", undefined, pwError)}
                  type="password"
                  value={current}
                  autoComplete="current-password"
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </Field>
              <Field id="pw-new" label="New password" hint="At least 10 characters.">
                <input
                  {...fieldAria("pw-new", "hint")}
                  type="password"
                  value={next}
                  autoComplete="new-password"
                  onChange={(e) => setNext(e.target.value)}
                />
              </Field>
            </div>
            <Button type="submit" variant="grey" disabled={!current || next.length < 10}>
              Change password
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

export function SettingsScreen() {
  const role = useOrg()?.role;
  return (
    <>
      <PageHeader eyebrow="Organisation" title="Settings">
        Your organisation, your notices and your security.
      </PageHeader>
      <NeedsOrg>{(orgId) => <Profile orgId={orgId} canEdit={role === "owner"} />}</NeedsOrg>
      <Security />
    </>
  );
}
