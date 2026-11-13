// Presentational components. No inline styles anywhere: the CSP is style-src 'self'.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./icon";

type ButtonVariant = "dark" | "grey" | "light" | "ghost-dark";

export function Button({
  variant = "dark",
  small = false,
  block = false,
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  small?: boolean;
  block?: boolean;
}) {
  const cls = ["btn", `btn-${variant}`, small && "btn-sm", block && "btn-block", className]
    .filter(Boolean)
    .join(" ");
  return <button type={type} className={cls} {...rest} />;
}

/** A link styled as a button. */
export function ButtonLink({
  href,
  variant = "dark",
  small = false,
  children,
  className = "",
}: {
  href: string;
  variant?: ButtonVariant;
  small?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const cls = ["btn", `btn-${variant}`, small && "btn-sm", className].filter(Boolean).join(" ");
  return (
    <a className={cls} href={href}>
      {children}
    </a>
  );
}

export type TagTone = "private" | "direct" | "success" | "warning" | "neutral" | "error";

export function Tag({ tone, children }: { tone: TagTone; children: ReactNode }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className={`field${error ? " field-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {children}
      {error ? (
        <span className="field-error-text" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** For an <input> inside a Field: the describedby and invalid attributes. */
export const fieldAria = (id: string, hint?: string, error?: string) => ({
  id,
  "aria-invalid": error ? true : undefined,
  "aria-describedby":
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined,
});

export function EmptyState({
  title,
  children,
  icon = "clock",
  action,
}: {
  title: string;
  children?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <SolidIcon name={icon} tone="indigo" />
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

/** The standard placeholder for a screen whose API isn't built yet. Never fake data. */
export function ComingLater({ what }: { what: string }) {
  return (
    <EmptyState title="Coming in a later slice" icon="clock">
      {what} needs API routes that don&apos;t exist yet. Nothing here is shown until they do.
    </EmptyState>
  );
}

export function Skeleton({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton-group" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className={`skeleton skeleton-${(i % 3) + 1}`} />
      ))}
    </div>
  );
}

export function Stepper({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="stepper">
      {steps.map((s, i) => (
        <li
          key={s}
          className={i < current ? "step-done" : undefined}
          aria-current={i === current ? "step" : undefined}
        >
          <span className="step-dot" aria-hidden="true">
            {i < current ? <Icon name="check" size={14} /> : i + 1}
          </span>
          {s}
          {i < current ? <span className="sr-only"> (done)</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** A decimal amount as text, never a float: mono, tabular, with its currency. */
export function AmountText({
  value,
  currency = "USDC",
}: {
  value: string | null;
  currency?: string;
}) {
  if (value === null) return <span className="amount">—</span>;
  const [whole = "0", frac = ""] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (frac + "00").slice(0, Math.max(2, frac.length));
  return (
    <span className="amount">
      {grouped}.{cents}
      <span className="cur">{currency}</span>
    </span>
  );
}

export function SolidIcon({
  name,
  tone,
}: {
  name: IconName;
  /** Amber ("private") only for things that are private. */
  tone: "indigo" | "private" | "mint";
}) {
  return (
    <span className={`solid-icon solid-${tone}`} aria-hidden="true">
      <Icon name={name} size={26} />
    </span>
  );
}

/** The placeholder mark (L42). Replace it here, in one place, when the real logo arrives. */
export function Logo({ label = true }: { label?: boolean }) {
  return (
    <span className="logo">
      <svg width="26" height="22" viewBox="0 0 26 22" aria-hidden="true" focusable="false">
        <path
          className="logo-mark-v"
          d="M2 2l11 18L24 2"
          fill="none"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path className="logo-veil" d="M7.5 2h11" strokeWidth="3.2" strokeLinecap="round" />
      </svg>
      {label ? "veylo" : <span className="sr-only">Veylo</span>}
    </span>
  );
}
