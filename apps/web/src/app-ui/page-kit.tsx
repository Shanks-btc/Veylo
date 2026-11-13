"use client";
// Small pieces every page uses so that every page has the same four states: loading (a skeleton),
// an error (plain words and a way to try again), empty (what to do next) and the content. Pages
// pass the result of useApi and say what "empty" means; nothing here knows about a particular API.
import type { ReactNode } from "react";
import { ErrorNote } from "./shell";
import { EmptyState, Skeleton } from "../ui/basic";
import type { IconName } from "../ui/icon";

export type Query<T> = { data?: T; error?: string; loading: boolean; reload: () => void };

export function LoadBlock<T>({
  query,
  label,
  lines = 3,
  isEmpty,
  empty,
  children,
}: {
  query: Query<T>;
  label: string;
  lines?: number;
  isEmpty?: (data: T) => boolean;
  empty?: { title: string; body: ReactNode; icon?: IconName; action?: ReactNode };
  children: (data: T) => ReactNode;
}) {
  if (query.loading) return <Skeleton lines={lines} label={`Loading ${label}`} />;
  if (query.error || query.data === undefined)
    return (
      <ErrorNote
        error={`Couldn't load ${label}. ${query.error ?? ""} Check your connection, then try again.`.trim()}
        onRetry={query.reload}
      />
    );
  if (isEmpty?.(query.data) && empty)
    return (
      <EmptyState
        title={empty.title}
        {...(empty.icon ? { icon: empty.icon } : {})}
        {...(empty.action ? { action: empty.action } : {})}
      >
        {empty.body}
      </EmptyState>
    );
  return <>{children(query.data)}</>;
}

/** A confirmation line after something was saved: plain words, announced to screen readers. */
export function Saved({ children }: { children: ReactNode }) {
  return (
    <p className="notice" role="status">
      {children}
    </p>
  );
}

/** A definition list of label and value pairs; stacks on phones. */
export function Facts({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
