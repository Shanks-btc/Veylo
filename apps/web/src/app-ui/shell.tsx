"use client";
// The signed-in app shell: grouped navigation (a bottom bar with a "More" sheet on phones), org
// switcher, user menu, theme toggle, FX provider and toasts. Signed-out visitors are sent to
// sign-in; nothing below renders without a session.
import { useEffect, useState, type ReactNode } from "react";
import { signOut } from "../auth/sign-in";
import { Logo, Skeleton } from "../ui/basic";
import { Icon, type IconName } from "../ui/icon";
import { Modal, ToastProvider, useToast } from "../ui/interactive";
import { FxProvider } from "./fx";
import { SessionProvider, useOrg, useSession } from "./session";
import { WalletPickerHost } from "./wallet-picker";

type NavItem = { href: string; label: string; icon: IconName; primary?: boolean };
type NavGroup = { title: string; items: readonly NavItem[] };

/** Every page of the owner app. The first four marked primary are the phone's bottom bar. */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    title: "Money",
    items: [
      { href: "/app", label: "Treasury", icon: "home", primary: true },
      { href: "/app/fund", label: "Fund treasury", icon: "wallet" },
      { href: "/app/pay-runs", label: "Pay runs", icon: "calendar", primary: true },
      { href: "/app/schedules", label: "Schedules", icon: "clock" },
      { href: "/app/ledger", label: "Ledger", icon: "receipt", primary: true },
      { href: "/app/statements", label: "Statements", icon: "file" },
    ],
  },
  {
    title: "People",
    items: [
      { href: "/app/contractors", label: "Contractors", icon: "users", primary: true },
      { href: "/app/contractors/import", label: "Import CSV", icon: "download" },
      { href: "/app/payees", label: "Payee registry", icon: "shield" },
    ],
  },
  {
    title: "Trust",
    items: [
      { href: "/app/privacy-proof", label: "Privacy", icon: "lock" },
      { href: "/app/audit", label: "Audit log", icon: "check" },
    ],
  },
  {
    title: "Organisation",
    items: [
      { href: "/app/team", label: "Team and roles", icon: "buildings" },
      { href: "/app/settings", label: "Settings", icon: "gear" },
      { href: "/docs", label: "Help", icon: "globe" },
    ],
  },
];

function useCurrentPath(): string {
  const [path, setPath] = useState("");
  useEffect(() => setPath(window.location.pathname.replace(/\/$/, "") || "/"), []);
  return path;
}

/** Longest matching nav entry wins, so /app/contractors/import doesn't also light up Contractors. */
export function activeHref(path: string): string | undefined {
  const all = NAV_GROUPS.flatMap((g) => g.items).map((i) => i.href);
  const singular = (h: string) => h.replace(/s$/, "");
  const hits = all.filter((h) =>
    h === "/app"
      ? path === "/app"
      : path === h || path.startsWith(`${h}/`) || path.startsWith(singular(h)),
  );
  return hits.sort((a, b) => b.length - a.length)[0];
}

function OrgSwitcher() {
  const { me, orgId, setOrgId } = useSession();
  if (!me || me.memberships.length === 0) return null;
  return (
    <label className="org-switch">
      <span className="sr-only">Organisation</span>
      <Icon name="buildings" size={18} />
      <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
        {me.memberships.map((m) => (
          <option key={m.orgId} value={m.orgId}>
            {m.orgName}
          </option>
        ))}
      </select>
    </label>
  );
}

function UserMenu() {
  const { me, api, wallet, setWallet, theme, setTheme } = useSession();
  const toast = useToast();
  const role = useOrg()?.role;
  if (!me) return null;
  const who = me.user.email ?? me.user.nearAccountId ?? "Account";
  return (
    <div className="topbar-actions">
      <button
        type="button"
        className="icon-btn"
        aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
        aria-pressed={theme === "dark"}
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      >
        <Icon name={theme === "dark" ? "sun" : "moon"} size={20} />
      </button>
      <details className="user-menu">
        <summary aria-label={`Account menu for ${who}`}>
          <Icon name="user" size={22} />
          <span className="user-name mono">{who}</span>
        </summary>
        <div className="user-menu-panel">
          <p className="mono">{who}</p>
          {role ? <p className="small">Your role: {role}</p> : null}
          <a href="/app/settings">Settings</a>
          <a href="/app/setup">Organisations</a>
          <button
            type="button"
            onClick={async () => {
              try {
                await signOut({ api, wallet: wallet?.signer });
                setWallet(undefined);
                window.location.assign("/app/sign-in");
              } catch (err) {
                toast("error", `Sign-out failed: ${err instanceof Error ? err.message : "error"}`);
              }
            }}
          >
            <Icon name="signOut" size={18} /> Sign out
          </button>
        </div>
      </details>
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const path = useCurrentPath();
  const active = activeHref(path);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (me === null) window.location.replace("/app/sign-in");
  }, [me]);
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <a className="sidebar-logo" href="/app" aria-label="Veylo, treasury home">
          <Logo />
        </a>
        <nav aria-label="App" className="app-nav">
          {NAV_GROUPS.map((g) => (
            <div key={g.title} className="app-nav-group">
              <span className="app-nav-title">{g.title}</span>
              {g.items.map((n) => (
                <a
                  key={n.href}
                  href={n.href}
                  className={n.primary ? undefined : "nav-secondary"}
                  aria-current={active === n.href ? "page" : undefined}
                >
                  <Icon name={n.icon} size={22} />
                  <span>{n.label}</span>
                </a>
              ))}
            </div>
          ))}
          <button
            type="button"
            className="nav-more"
            aria-haspopup="dialog"
            onClick={() => setMore(true)}
          >
            <Icon name="dots" size={22} />
            <span>More</span>
          </button>
        </nav>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <OrgSwitcher />
          <UserMenu />
        </header>
        <main id="main" className="app-content">
          {me ? children : <Skeleton lines={4} label="Loading your account" />}
        </main>
      </div>
      <WalletPickerHost />
      <Modal open={more} title="All of Veylo" onClose={() => setMore(false)}>
        <nav aria-label="All pages">
          {NAV_GROUPS.map((g) => (
            <section key={g.title} className="stack">
              <h3>{g.title}</h3>
              <ul className="more-list">
                {g.items.map((n) => (
                  <li key={n.href}>
                    <a href={n.href} aria-current={active === n.href ? "page" : undefined}>
                      <Icon name={n.icon} size={22} />
                      {n.label}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
      </Modal>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <ToastProvider>
        <FxProvider>
          <Frame>{children}</Frame>
        </FxProvider>
      </ToastProvider>
    </SessionProvider>
  );
}

export function PageHeader({
  title,
  eyebrow,
  actions,
  children,
}: {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {eyebrow ? <span className="eye">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {children ? <p className="page-lede">{children}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

/** Shown when a screen needs an organisation and none is selected yet. */
export function NeedsOrg({ children }: { children: (orgId: string) => ReactNode }) {
  const { orgId, me } = useSession();
  if (!me) return null;
  if (!orgId) {
    return (
      <div className="empty">
        <h2>No organisation yet</h2>
        <p>Create one to link your treasury account.</p>
        <a className="btn btn-dark" href="/app/setup">
          Set up an organisation
        </a>
      </div>
    );
  }
  return <>{children(orgId)}</>;
}

export function ErrorNote({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="error-note" role="alert">
      <Icon name="warning" size={20} />
      <span>{error}</span>
      {onRetry ? (
        <button type="button" className="btn btn-grey btn-sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
