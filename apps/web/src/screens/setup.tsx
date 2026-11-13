"use client";
// Organisation setup (slice W6): the shortest path from a new account to a first payment. Sign up
// with email, create a wallet (a passkey and a recovery phrase), name the organisation, fund it
// with USDC on NEAR, add a contractor, pay. Each step is one button; help is in place, in plain
// words. The treasury is the owner's wallet account (ARCHITECTURE §5): the API can't name another.
import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { linkWallet } from "../auth/link";
import { PageHeader, ErrorNote } from "../app-ui/shell";
import { useSession } from "../app-ui/session";
import { WalletPicker } from "../app-ui/wallet-picker";
import { EMBEDDED_ID } from "../wallet/registry";
import { Button, Field, fieldAria, Tag } from "../ui/basic";
import { AddressText, Card, useToast } from "../ui/interactive";
import { QrCode } from "../ui/qr";

type StepState = "success" | "current" | "todo";

function Step({
  title,
  state,
  children,
}: {
  title: string;
  state: StepState;
  children?: React.ReactNode;
}) {
  return (
    <li data-state={state}>
      <h3>{title}</h3>
      <div className="step-action stack">
        {state === "success" ? <span className="muted small">Done</span> : children}
      </div>
    </li>
  );
}

export function SetupScreen() {
  const { api, me, config, refreshMe, setOrgId, connectWallet, now } = useSession();
  const toast = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  if (!me) return null;

  const hasWallet = me.user.nearAccountId !== null;
  const hasOrg = me.memberships.length > 0;
  const account = me.user.nearAccountId;

  async function afterWallet(w: Awaited<ReturnType<typeof connectWallet>>) {
    setBusy(true);
    setError(undefined);
    try {
      if (!me?.user.nearAccountId) {
        // An email account proves it controls the wallet by a signature, then links it.
        await linkWallet({
          api,
          wallet: w.signer,
          userId: me?.user.id ?? "",
          authRecipient: config.authRecipient,
          now,
        });
        await refreshMe();
        toast("success", "Your wallet is ready and linked to your account.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't link the wallet.");
    } finally {
      setBusy(false);
    }
  }

  async function createVeyloWallet() {
    setBusy(true);
    setError(undefined);
    try {
      const w = await connectWallet(EMBEDDED_ID, "create");
      await afterWallet(w);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the wallet.");
      setBusy(false);
    }
  }

  async function onCreateOrg(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError("Enter your organisation's name.");
    setBusy(true);
    setError(undefined);
    try {
      const org = await api.call("POST /orgs", { body: { name: trimmed } });
      await refreshMe();
      setOrgId(org.id);
      toast("success", `${org.name} created.`);
      setName("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the organisation.");
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    try {
      await api.call("POST /auth/resend-verification", { body: {} });
      toast("success", "We sent you a new confirmation link.");
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Couldn't send the link.");
    }
  }

  const walletState: StepState = hasWallet ? "success" : "current";
  const orgState: StepState = hasOrg ? "success" : hasWallet ? "current" : "todo";
  const afterOrg: StepState = hasOrg ? "current" : "todo";

  return (
    <>
      <PageHeader eyebrow="Setup" title="Set up your payroll">
        Five short steps: your wallet, your organisation, your funds, your first contractor, your
        first payment.
      </PageHeader>

      {me.user.email && !me.user.emailVerified ? (
        <div className="notice" role="status">
          <p>
            Confirm your email ({me.user.email}) with the link we sent. It is for notices and
            signing in; it can&apos;t approve payments.
          </p>
          <Button variant="grey" small onClick={resend}>
            Send me a new link
          </Button>
        </div>
      ) : null}

      <ol className="steps">
        <Step title="Create your wallet" state={walletState}>
          <p className="muted">
            Your wallet holds the key that approves payments. It is made on this device, protected
            by a passkey, with a recovery phrase you keep. No app to install.
          </p>
          <p className="small muted">
            Only you hold this wallet&apos;s key. If you lose this device and your recovery phrase,
            Veylo can&apos;t recover it.
          </p>
          <div className="actions">
            <Button onClick={createVeyloWallet} disabled={busy}>
              {busy ? "Working…" : "Create my Veylo wallet"}
            </Button>
            <Button variant="grey" onClick={() => setPicker(true)} disabled={busy}>
              Connect an existing wallet
            </Button>
          </div>
        </Step>

        <Step title="Name your organisation" state={orgState}>
          <form className="form" onSubmit={onCreateOrg} noValidate>
            <Field id="org-name" label="Organisation name" error={hasWallet ? error : undefined}>
              <input
                {...fieldAria("org-name", undefined, hasWallet ? error : undefined)}
                value={name}
                maxLength={200}
                autoComplete="organization"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            {account ? (
              <div className="stack">
                <span className="muted small">Your treasury is your wallet account</span>
                <AddressText value={account} label="treasury account" />
                <div className="stack">
                  <QrCode value={account} label="QR code of your wallet account" />
                  <p className="small muted">
                    This is your wallet&apos;s account. To add money, use{" "}
                    <strong>Fund treasury</strong> next: it gives you the exact address to send USDC
                    to.
                  </p>
                </div>
              </div>
            ) : null}
            <Button type="submit" disabled={busy || !hasWallet}>
              {busy ? "Creating…" : "Create organisation"}
            </Button>
          </form>
        </Step>

        <Step title="Fund your treasury with USDC" state={afterOrg}>
          <p className="muted">
            Your treasury is held in USDC, so payroll doesn&apos;t change with crypto prices. Send
            USDC on the NEAR network.
          </p>
          <a className="btn btn-dark" href="/app/fund">
            Fund treasury
          </a>
        </Step>

        <Step title="Add your first contractor" state={afterOrg}>
          <p className="muted">One at a time, or many from a spreadsheet.</p>
          <div className="actions">
            <a className="btn btn-dark" href="/app/contractors">
              Add a contractor
            </a>
            <a className="btn btn-grey" href="/app/contractors/import">
              Import from CSV
            </a>
          </div>
        </Step>

        <Step title="Pay" state={afterOrg}>
          <p className="muted">
            Review the pay run, check it in your browser, and approve each payout in your wallet.
          </p>
          <a className="btn btn-dark" href="/app/pay-runs">
            Open pay runs
          </a>
        </Step>
      </ol>

      {error && !hasWallet ? <ErrorNote error={error} /> : null}

      {hasOrg ? (
        <Card>
          <h2 className="section-title">Your organisations</h2>
          <ul className="list-plain">
            {me.memberships.map((m) => (
              <li key={m.orgId}>
                <span>{m.orgName}</span>
                <Tag tone="neutral">{m.role}</Tag>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <WalletPicker
        open={picker}
        onClose={() => setPicker(false)}
        onConnected={(w) => void afterWallet(w)}
        title="Connect a wallet"
      />
    </>
  );
}
