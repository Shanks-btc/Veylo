// Scroll-reveal wrapper (server component: plain markup, no per-element client code). One
// RevealController (reveal-controller.tsx) finds every .rev element and drives the classes. Content
// is visible without script: "pre" (hidden) is added only by script, only for elements below the
// fold, and never under reduced motion.
import type { ReactNode } from "react";

export function Reveal({
  children,
  className = "",
  as: Tag = "div",
  scrollLabel,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "article";
  /** For a block that scrolls sideways on a small screen: a keyboard can reach it, and it has a name. */
  scrollLabel?: string;
}) {
  return (
    <Tag
      className={`rev ${className}`.trim()}
      {...(scrollLabel ? { tabIndex: 0, role: "region", "aria-label": scrollLabel } : {})}
    >
      {children}
    </Tag>
  );
}
