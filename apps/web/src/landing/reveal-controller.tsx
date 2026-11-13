"use client";
// The one client island behind every <Reveal>: a single IntersectionObserver for all .rev
// elements, instead of one client component (and one hydration) per section.
import { useEffect } from "react";
import { prefersReducedMotion } from "../ui/motion";

export function RevealController() {
  useEffect(() => {
    const items = [...document.querySelectorAll<HTMLElement>(".rev")];
    if (items.length === 0) return;
    if (prefersReducedMotion() || !("IntersectionObserver" in window)) {
      for (const el of items) el.classList.add("drawn");
      return;
    }
    const seen = new Set<Element>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          // The first report of an element gives its position without forcing a layout.
          if (!seen.has(el)) {
            seen.add(el);
            if (!e.isIntersecting && e.boundingClientRect.top > window.innerHeight) {
              el.classList.add("pre");
              continue;
            }
          }
          if (!e.isIntersecting) continue;
          el.classList.remove("pre");
          el.classList.add("drawn");
          io.unobserve(el);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    for (const el of items) io.observe(el);
    const fallback = window.setTimeout(() => {
      for (const el of items) el.classList.remove("pre");
    }, 2500);
    return () => {
      io.disconnect();
      window.clearTimeout(fallback);
    };
  }, []);
  return null;
}
