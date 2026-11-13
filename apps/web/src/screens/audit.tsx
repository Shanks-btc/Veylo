"use client";
// Audit log (slice W6): an append-only record of who did what. Filter it, read it, and export what
// you see as a CSV. It holds no secret, no signature and no token: only who, what, when and the
// transaction where there is one. The API only ever adds to it.
import { useCallback, useEffect, useState } from "react";
import type { auditResponse } from "@veylo/contract";
import type { z } from "zod";
import { ApiError } from "../api/client";
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useSession } from "../app-ui/session";
import { downloadBytes } from "../reports/download";
import { EmptyState, Button, Field, Skeleton } from "../ui/basic";
import { Table } from "../ui/data";
import { Card } from "../ui/interactive";

type Item = z.infer<typeof auditResponse>["items"][number];

const GROUPS: readonly (readonly [string, string])[] = [
  ["", "Everything"],
  ["auth.*", "Sign-ins and accounts"],
  ["org.*", "Organisation"],
  ["member.*", "Team"],
  ["contractor.*", "Contractors"],
  ["payee.*", "Payee registry"],
  ["pay_run.*", "Pay runs"],
  ["treasury.*", "Treasury"],
];

/** "pay_run.approve" becomes "Pay run: approve", for people. */
export function plainAction(action: string): string {
  const [area = "", ...rest] = action.split(".");
  const a = area.replaceAll("_", " ");
  return `${a.charAt(0).toUpperCase()}${a.slice(1)}: ${rest.join(" ").replaceAll("_", " ")}`;
}

const csvCell = (v: string) => (/^[=+\-@]/.test(v) ? `'${v}` : v);
const quote = (v: string) => `"${csvCell(v).replaceAll('"', '""')}"`;

function Audit({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const [group, setGroup] = useState("");
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();

  const load = useCallback(
    async (cursor?: string) => {
      setState("loading");
      try {
        const r = await api.call("GET /orgs/:orgId/audit", {
          params: { orgId },
          query: {
            limit: "50",
            ...(group ? { action: group } : {}),
            ...(cursor ? { cursor } : {}),
          },
        });
        setItems((cur) => (cursor ? [...cur, ...r.items] : r.items));
        setNext(r.nextCursor);
        setState("ready");
      } catch (err) {
        setError(
          err instanceof ApiError && err.status === 403
            ? "Only owners and accountants can read the audit log."
            : "Couldn't load the audit log.",
        );
        setState("error");
      }
    },
    [api, orgId, group],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const shown = items.filter((i) => {
    const day = i.at.slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    const hay = `${i.actor} ${i.action} ${i.entity} ${i.entityId}`.toLowerCase();
    return !text.trim() || hay.includes(text.trim().toLowerCase());
  });

  function exportCsv() {
    const rows = [
      ["when (UTC)", "who", "action", "entity", "entity id", "transaction"].join(","),
    ].concat(
      shown.map((i) =>
        [i.at, i.actor, i.action, i.entity, i.entityId, i.txHash ?? ""].map(quote).join(","),
      ),
    );
    downloadBytes(new TextEncoder().encode(rows.join("\r\n")), "veylo-audit-log.csv", "text/csv");
  }

  return (
    <div className="stack">
      <Card>
        <div className="filters">
          <Field id="a-group" label="Show">
            <select id="a-group" value={group} onChange={(e) => setGroup(e.target.value)}>
              {GROUPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field id="a-text" label="Search">
            <input
              id="a-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field id="a-from" label="From">
            <input id="a-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field id="a-to" label="To">
            <input id="a-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </Card>
      {state === "error" ? (
        <ErrorNote error={error ?? "Couldn't load the audit log."} onRetry={() => void load()} />
      ) : state === "loading" && items.length === 0 ? (
        <Skeleton lines={5} label="Loading the audit log" />
      ) : shown.length === 0 ? (
        <EmptyState title="Nothing matches" icon="check">
          Nothing in the audit log matches these filters yet.
        </EmptyState>
      ) : (
        <Table
          caption="Audit log"
          rows={shown}
          rowKey={(i) => i.id}
          columns={[
            { key: "at", label: "When (UTC)", render: (i) => i.at.replace("T", " ").slice(0, 19) },
            {
              key: "actor",
              label: "Who",
              render: (i) => <span className="mono">{i.actor.slice(0, 8)}</span>,
            },
            { key: "action", label: "What", render: (i) => plainAction(i.action) },
            {
              key: "entity",
              label: "About",
              render: (i) => (
                <span className="mono">
                  {i.entity} {i.entityId.slice(0, 8)}
                </span>
              ),
            },
            {
              key: "tx",
              label: "Transaction",
              render: (i) =>
                i.txHash ? (
                  <a
                    href={`https://nearblocks.io/txns/${i.txHash}`}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    View
                  </a>
                ) : (
                  <span className="muted small">None</span>
                ),
            },
          ]}
        />
      )}
      <div className="actions">
        {next ? (
          <Button variant="grey" onClick={() => void load(next)} disabled={state === "loading"}>
            Load more
          </Button>
        ) : null}
        <Button variant="grey" onClick={exportCsv} disabled={shown.length === 0}>
          Export what I see (CSV)
        </Button>
      </div>
      <p className="page-note">
        The audit log only ever adds to itself: nothing here can be edited or removed.
      </p>
    </div>
  );
}

export function AuditScreen() {
  return (
    <>
      <PageHeader eyebrow="Trust" title="Audit log">
        Who did what, and when.
      </PageHeader>
      <NeedsOrg>{(orgId) => <Audit orgId={orgId} />}</NeedsOrg>
    </>
  );
}
