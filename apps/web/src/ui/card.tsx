"use client";
// Card, with an optional hover tilt, cursor glow and animated border (none under reduced motion).
// Its own module, so the landing page's cards don't pull in modals, toasts and tabs.
import { useEffect, useRef, type ReactNode } from "react";
import { prefersReducedMotion } from "./motion";

/** Card with an optional hover tilt, cursor glow and animated border; none under reduced motion. */
export function Card({
  children,
  fx = false,
  size = "md",
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  fx?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
  as?: "div" | "article" | "section";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!fx || !el || prefersReducedMotion()) return;
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
  }, [fx]);
  const cls = ["card", size !== "md" && `card-${size}`, fx && "card-fx", className]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag ref={ref as never} className={cls}>
      {children}
      {fx ? <span className="glare" aria-hidden="true" /> : null}
    </Tag>
  );
}
