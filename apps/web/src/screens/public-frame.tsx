// The frame for the public pages (slice W6): Docs, Security, Privacy policy, Terms. Plain server
// components, no script. Every link here is a real page; a crawler test fails on one that isn't.
import type { ReactNode } from "react";
import { ButtonLink, Logo } from "../ui/basic";

/** Where the public footer and the landing footer point. One list, so they can't drift apart. */
export const PUBLIC_LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/security", label: "Security" },
  { href: "/privacy", label: "Privacy policy" },
  { href: "/terms", label: "Terms" },
  { href: "/verify", label: "Verify a payout" },
  { href: "/proof", label: "What the public sees" },
] as const;

export const REPO_URL = "https://github.com/Shanks-btc/Veylo";

export function PublicFrame({
  title,
  lede,
  toc,
  children,
}: {
  title: string;
  lede?: ReactNode;
  toc?: readonly { id: string; label: string }[];
  children: ReactNode;
}) {
  return (
    <div className="public-page">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="public-head wrap">
        <a href="/" aria-label="Veylo, home">
          <Logo />
        </a>
        <nav aria-label="Main" className="public-nav">
          <a href="/docs">Docs</a>
          <a href="/security">Security</a>
          <a href="/privacy">Privacy policy</a>
        </nav>
        <ButtonLink href="/app/sign-in" small>
          Open app
        </ButtonLink>
      </header>
      <main id="main" className="public-main wrap">
        <h1>{title}</h1>
        {lede ? <p className="page-lede">{lede}</p> : null}
        {toc ? (
          <nav className="doc-toc" aria-label="On this page">
            <ul>
              {toc.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`}>{t.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <article className="prose">{children}</article>
      </main>
      <footer className="public-foot wrap">
        <nav aria-label="Footer">
          {PUBLIC_LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <span>Private payroll on NEAR.</span>
      </footer>
    </div>
  );
}
