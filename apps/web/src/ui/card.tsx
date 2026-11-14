// Card: plain markup (a server component, no script of its own). The hover tilt, cursor glow and
// animated border of a `fx` card are driven for every such card on a page by one client island
// (landing/card-fx.tsx), so a page with a dozen of them hydrates one component, not a dozen. Its own
// module, so the landing page's cards don't pull in modals, toasts and tabs.
import type { ReactNode } from "react";

/** Card; with `fx`, the landing page's CardFx adds the tilt (none under reduced motion). */
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
  const cls = ["card", size !== "md" && `card-${size}`, fx && "card-fx", className]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag className={cls}>
      {children}
      {fx ? <span className="glare" aria-hidden="true" /> : null}
    </Tag>
  );
}
