"use client";
// The hover tilt and cursor glow of every `.card-fx` card on the page, and the one-time count-up of the
// hero panel's balance, from one client island (as RevealController does for the reveals). None of it
// runs under reduced motion (the balance simply stays at its final value), and the tilt needs a fine
// pointer, where a tilt has meaning.
//
// The count-up is whole cents only: the element carries its final amount in cents, the island counts
// 0 → that with integer arithmetic, and the last frame shows the exact text the server wrote.
import { useEffect } from "react";
import { prefersReducedMotion } from "../ui/motion";

/** How long the balance takes to count up from zero. */
const COUNT_MS = 600;

/** Whole cents as dollars: 24842050 → "$248,420.50". */
export function formatCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  const frac = cents - whole * 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${grouped}.${frac < 10 ? "0" : ""}${frac}`;
}

/** The balance after `elapsed` of `total` ms, in whole cents, easing out (all integer arithmetic). */
export function centsAt(target: number, elapsed: number, total: number): number {
  if (elapsed >= total) return target;
  if (elapsed <= 0) return 0;
  const left = total - elapsed;
  // 1 - (1 - t)^2 with t = elapsed / total, scaled to avoid fractions.
  const eased = total * total - left * left;
  return Math.floor((target * eased) / (total * total));
}

// The final amount stays in the page the whole time (`.hp-final`: it holds the space, and it is what a
// screen reader reads). While the balance counts, the running figure is drawn over it (`.hp-live`,
// positioned on top and hidden from a screen reader). So the width of the text never changes, and
// nothing next to it moves (CLS stays 0).
function countUp(el: HTMLElement): () => void {
  const target = +(el.dataset.countCents ?? "0");
  const delay = +(el.dataset.countDelay ?? "0");
  const live = el.querySelector<HTMLElement>(".hp-live");
  if (!live || !(target > 0)) return () => undefined;
  const stop = () => {
    el.classList.remove("counting");
    live.textContent = "";
  };
  el.classList.add("counting");
  live.textContent = formatCents(0);
  let frame = 0;
  const begin = window.setTimeout(() => {
    const t0 = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.floor(now - t0);
      if (elapsed >= COUNT_MS) return stop();
      live.textContent = formatCents(centsAt(target, elapsed, COUNT_MS));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }, delay);
  return () => {
    window.clearTimeout(begin);
    cancelAnimationFrame(frame);
    stop();
  };
}

function tilt(el: HTMLElement): () => void {
  const move = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty(
      "transform",
      `perspective(900px) rotateX(${(0.5 - y) * 5}deg) rotateY(${(x - 0.5) * 6}deg) translateY(-4px)`,
    );
    el.style.setProperty("--gx", `${x * 100}%`);
    el.style.setProperty("--gy", `${y * 100}%`);
  };
  const leave = () => el.style.removeProperty("transform");
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerleave", leave);
  return () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerleave", leave);
  };
}

export function CardFx() {
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const undo: (() => void)[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("[data-count-cents]")) {
      undo.push(countUp(el));
    }
    if (globalThis.matchMedia?.("(hover: hover) and (pointer: fine)").matches) {
      for (const el of document.querySelectorAll<HTMLElement>(".card-fx")) undo.push(tilt(el));
    }
    return () => {
      for (const f of undo) f();
    };
  }, []);
  return null;
}
