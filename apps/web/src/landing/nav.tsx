"use client";
// 1. Glass pill nav. Under 980px the links move into a drawer: a native modal dialog, so focus is
// trapped inside it (and the page behind is inert), Escape closes it, and focus returns to the menu
// button. On top of that: the page behind can't scroll while it is open, a tap on the backdrop or on
// a link closes it, and it slides and fades in and out (instantly under reduced motion).
import { useEffect, useRef, useState } from "react";
import { ButtonLink, Logo } from "../ui/basic";
import { Icon } from "../ui/icon";
import { prefersReducedMotion } from "../ui/motion";

/** How it works, Features, Tour, Docs. The FAQ is on the page and in the footer, not here. */
export const NAV_LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#product", label: "Features" },
  { href: "#story", label: "Tour" },
  { href: "/docs", label: "Docs" },
] as const;

export const SIGN_IN = { href: "/app/sign-in", label: "Sign in" } as const;

/** The same length as the drawer-out animation in landing.css. */
const CLOSE_MS = 220;
const LOCK_CLASS = "nav-locked";
/**
 * Before the page's script has loaded, a modern browser still opens the dialog by itself (the invoker
 * attributes). The type definitions don't know them yet, so they are spread in as plain attributes.
 */
const INVOKER = { command: "show-modal", commandfor: "mobile-menu" } as object;

export function LandingNav() {
  const drawer = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const requestClose = () => {
    const d = drawer.current;
    if (!d?.open) return;
    if (prefersReducedMotion()) return d.close();
    d.classList.add("is-closing");
    window.setTimeout(() => d.close(), CLOSE_MS);
  };

  // A drawer left open while the window grows past the breakpoint would hide a page that is now
  // fully navigable: close it at once.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 981px)");
    const onChange = () => {
      if (wide.matches) drawer.current?.close();
    };
    wide.addEventListener("change", onChange);
    return () => {
      wide.removeEventListener("change", onChange);
      document.documentElement.classList.remove(LOCK_CLASS);
    };
  }, []);

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
        <ButtonLink href={SIGN_IN.href} small className="nav-open">
          {SIGN_IN.label}
        </ButtonLink>
        <button
          ref={opener}
          type="button"
          className="nav-menu-btn"
          aria-label="Open menu"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls="mobile-menu"
          {...INVOKER}
          onClick={() => {
            drawer.current?.showModal();
            document.documentElement.classList.add(LOCK_CLASS);
            setOpen(true);
          }}
        >
          <Icon name="menu" size={24} />
        </button>
      </div>
      <dialog
        id="mobile-menu"
        ref={drawer}
        className="drawer"
        aria-label="Menu"
        onCancel={(e) => {
          // Escape: close with the same short animation as every other way out.
          e.preventDefault();
          requestClose();
        }}
        onClose={() => {
          drawer.current?.classList.remove("is-closing");
          document.documentElement.classList.remove(LOCK_CLASS);
          setOpen(false);
          opener.current?.focus();
        }}
        onKeyDown={(e) => {
          // Keep Tab and Shift+Tab inside the drawer: past the last control it wraps to the first.
          if (e.key !== "Tab") return;
          const items = [
            ...e.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
          ];
          const first = items[0];
          const last = items[items.length - 1];
          if (!first || !last) return;
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
        onClick={(e) => {
          // A tap on the backdrop reports the dialog itself as its target; the panel fills the rest.
          if (e.target === e.currentTarget) requestClose();
        }}
      >
        <div className="drawer-panel">
          <div className="drawer-head">
            <a className="brand" href="#top" aria-label="Veylo, back to top" onClick={requestClose}>
              <Logo />
            </a>
            <button type="button" aria-label="Close menu" onClick={requestClose}>
              <Icon name="close" size={20} />
            </button>
          </div>
          <nav aria-label="Mobile">
            {NAV_LINKS.map((l) => (
              <a key={l.label} href={l.href} onClick={requestClose}>
                <span>{l.label}</span>
                <Icon name="arrowRight" size={18} />
              </a>
            ))}
          </nav>
          <div className="drawer-foot">
            <ButtonLink href={SIGN_IN.href} variant="light" onClick={requestClose}>
              {SIGN_IN.label}
            </ButtonLink>
          </div>
        </div>
      </dialog>
    </div>
  );
}
