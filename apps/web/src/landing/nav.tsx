"use client";
// 1. Glass pill nav. Under 980px the links move into a drawer: a native modal dialog, so focus is
// trapped inside it, Escape closes it, and focus returns to the menu button.
import { useRef } from "react";
import { ButtonLink, Logo } from "../ui/basic";
import { Icon } from "../ui/icon";

export const NAV_LINKS = [
  { href: "#story", label: "Tour" },
  { href: "#product", label: "Features" },
  { href: "#how", label: "How it works" },
  { href: "#faq", label: "FAQ" },
  { href: "/docs", label: "Docs" },
] as const;

export function LandingNav() {
  const drawer = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => drawer.current?.close();
  return (
    <div className="navwrap">
      <div className="nav">
        <a className="brand" href="#top" aria-label="Veylo, back to top">
          <Logo />
        </a>
        <nav aria-label="Main" className="nav-links">
          {NAV_LINKS.map((l) => (
            <a key={l.label} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <ButtonLink href="/app/sign-in" small className="nav-open">
          Open app
        </ButtonLink>
        <button
          ref={opener}
          type="button"
          className="nav-menu-btn"
          aria-label="Open menu"
          aria-haspopup="dialog"
          onClick={() => drawer.current?.showModal()}
        >
          <Icon name="menu" size={24} />
        </button>
      </div>
      <dialog
        ref={drawer}
        className="drawer"
        aria-label="Menu"
        onClose={() => opener.current?.focus()}
      >
        <div className="drawer-head">
          <Logo />
          <button type="button" aria-label="Close menu" onClick={close}>
            <Icon name="close" size={20} />
          </button>
        </div>
        <nav aria-label="Mobile">
          {NAV_LINKS.map((l) => (
            <a key={l.label} href={l.href} onClick={close}>
              {l.label}
            </a>
          ))}
        </nav>
        <ButtonLink href="/app/sign-in">Open app</ButtonLink>
      </dialog>
    </div>
  );
}
