"use client";
// The portal's shared frame (slice W6): header, navigation, footer, the sign-in choices and the gate
// that finds the signed-in contractor. Each page of the portal builds on it.
import type { portalMe } from "@veylo/contract";
import { useState, type ReactNode } from "react";
import type { z } from "zod";
import { signIn, signOut } from "../auth/sign-in";
import { FxProvider } from "../app-ui/fx";
import { LoadBlock } from "../app-ui/page-kit";
import { SessionProvider, useApi, useQueryParam, useSession } from "../app-ui/session";
import { ErrorNote } from "../app-ui/shell";
import { WalletPicker, WalletPickerHost } from "../app-ui/wallet-picker";
import { Button, ButtonLink, Field, Logo, Skeleton } from "../ui/basic";
import { Card, ToastProvider, useToast } from "../ui/interactive";

export type PortalContractor = z.infer<typeof portalMe>["contractors"][number];

const NAV = [
  { href: "/portal", label: "Payments" },
  { href: "/portal/address", label: "Payout address" },
  { href: "/portal/balance", label: "Balance and cash out" },
] as const;

function Chrome({ active, children }: { active: string; children: ReactNode }) {
  const { me, api, wallet, setWallet } = useSession();
  const c = useQueryParam("c");
  const toast = useToast();
  const suffix = c ? `?c=${c}` : "";
  return (
    <div className="portal-page">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="portal-head wrap">
        <a href="/" aria-label="Veylo, home">
          <Logo />
        </a>
        <span className="eye">Contractor portal</span>
        {me ? (
          <Button
            variant="grey"
            small
            onClick={async () => {
              try {
                await signOut({ api, wallet: wallet?.signer });
                setWallet(undefined);
                window.location.assign("/portal");
              } catch (err) {
                toast("error", `Sign-out failed: ${err instanceof Error ? err.message : "error"}`);
              }
            }}
          >
            Sign out
          </Button>
        ) : null}
      </header>
      {me ? (
        <nav className="portal-nav wrap" aria-label="Portal">
          {NAV.map((n) => (
            <a
              key={n.href}
              href={`${n.href}${suffix}`}
              aria-current={active === n.href ? "page" : undefined}
            >
              {n.label}
            </a>
          ))}
        </nav>
      ) : null}
      <main id="main" className="portal-main wrap">
        {children}
      </main>
      <footer className="portal-foot wrap">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/docs">Help</a>
      </footer>
      <WalletPickerHost />
    </div>
  );
}

/** Every portal page: its own session, toasts and exchange-rate estimates. */
export function PortalPage({ active, children }: { active: string; children: ReactNode }) {
  return (
    <SessionProvider>
      <ToastProvider>
        <FxProvider>
          <Chrome active={active}>{children}</Chrome>
        </FxProvider>
      </ToastProvider>
    </SessionProvider>
  );
}

/** Email or wallet: the two ways in, each one step. The way back (?next=) is only ever a portal page. */
export function PortalSignIn({ next, title }: { next: string; title: string }) {
  const { api, config, refreshMe } = useSession();
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const q = `?next=${encodeURIComponent(next)}`;

  async function onWallet(w: { signer: Parameters<typeof signIn>[0]["wallet"] }) {
    setBusy(true);
    setError(undefined);
    try {
      await signIn({
        api,
        wallet: w.signer,
        authRecipient: config.authRecipient,
        now: () => new Date(),
      });
      await refreshMe();
    } catch (err) {
      setError(`Sign-in failed: ${err instanceof Error ? err.message : "error"}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="lg" className="stack">
      <h1>{title}</h1>
      <p className="muted">
        Use the email you were invited with, or connect a NEAR wallet. Signing in never moves money.
      </p>
      <div className="actions">
        <ButtonLink href={`/app/sign-up${q}`}>Create an account with email</ButtonLink>
        <ButtonLink href={`/app/sign-in${q}`} variant="grey">
          I already have an account
        </ButtonLink>
      </div>
      <div className="stack">
        <Button variant="grey" onClick={() => setPicker(true)} disabled={busy}>
          Use a NEAR wallet instead
        </Button>
        <p className="small muted">You sign one message. Nothing moves and there is no gas.</p>
      </div>
      {error ? <ErrorNote error={error} /> : null}
      <WalletPicker
        open={picker}
        onClose={() => setPicker(false)}
        onConnected={onWallet}
        title="Sign in with a wallet"
      />
    </Card>
  );
}

/**
 * Signed out → the sign-in choices. Signed in → the contractor (or the chosen one when this person is
 * paid by several organisations). Handles loading, error and "nobody linked yet" in plain words.
 */
export function PortalGate({
  next,
  children,
}: {
  next: string;
  children: (c: PortalContractor, reload: () => void) => ReactNode;
}) {
  const { me, api } = useSession();
  const pick = useQueryParam("c");
  const mine = useApi(me ? () => api.call("GET /portal/me") : undefined, [me?.user.id]);
  if (me === undefined || pick === undefined) return <Skeleton lines={3} label="Loading" />;
  if (me === null) return <PortalSignIn next={next} title="Sign in to see your payments" />;
  return (
    <LoadBlock
      query={mine}
      label="your account"
      isEmpty={(d) => d.contractors.length === 0}
      empty={{
        title: "No payroll is linked to your account yet",
        body: "Open the invite link your organisation sent you. If you lost it, ask them for a new one.",
        icon: "users",
      }}
    >
      {(d) => {
        const chosen = d.contractors.find((x) => x.contractorId === pick) ?? d.contractors[0];
        if (!chosen) return null;
        return (
          <div className="stack">
            {d.contractors.length > 1 ? (
              <Field id="portal-org" label="Organisation">
                <select
                  id="portal-org"
                  value={chosen.contractorId}
                  onChange={(e) => {
                    const u = new URL(window.location.href);
                    u.searchParams.set("c", e.target.value);
                    window.location.assign(u.toString());
                  }}
                >
                  {d.contractors.map((x) => (
                    <option key={x.contractorId} value={x.contractorId}>
                      {x.orgName}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {children(chosen, mine.reload)}
          </div>
        );
      }}
    </LoadBlock>
  );
}
