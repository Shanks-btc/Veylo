"use client";
// CSV import (slice W6): add many contractors from a spreadsheet. First "Check" shows every row with
// its problems and saves nothing. Then "Save" creates the good rows as contractors waiting for your
// treasury wallet to approve their addresses; nothing is payable until you do.
import { useState, type ChangeEvent } from "react";
import { ApiError } from "../api/client";
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useSession } from "../app-ui/session";
import { downloadBytes } from "../reports/download";
import { Button, EmptyState, Field, Tag } from "../ui/basic";
import { Table } from "../ui/data";
import { Card, useToast } from "../ui/interactive";

const SAMPLE =
  "name,email,route,near_account\nAda Lovelace,ada@example.com,private,ada-l.near\nGrace Hopper,,private,grace-h.near\n";
const MAX_BYTES = 200_000;

type Result = {
  rows: { line: number; name: string; ok: boolean; problems: string[] }[];
  saved: boolean;
  created: number;
};

function Import({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const toast = useToast();
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<Result>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function run(save: boolean) {
    if (!csv.trim()) return setError("Paste your spreadsheet or choose a CSV file first.");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.call("POST /orgs/:orgId/contractors/import", {
        params: { orgId },
        body: { csv, save },
      });
      setResult(r);
      if (r.saved)
        toast(
          "success",
          `${r.created} contractor${r.created === 1 ? "" : "s"} added. Approve their addresses next.`,
        );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check the file. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BYTES)
      return setError("That file is too large. Split it into smaller files.");
    setCsv(await file.text());
    setResult(undefined);
    setError(undefined);
  }

  const bad = result?.rows.filter((r) => !r.ok).length ?? 0;
  const good = result ? result.rows.length - bad : 0;

  return (
    <div className="stack">
      <Card className="stack">
        <h2 className="section-title">1. Add your file</h2>
        <p className="muted">
          Columns: <span className="mono">name, email, route, near_account</span>. Route is{" "}
          <span className="mono">private</span> or <span className="mono">direct</span>. Every NEAR
          account is checked on NEAR before anything is saved.
        </p>
        <div className="actions">
          <Button
            variant="grey"
            onClick={() =>
              downloadBytes(new TextEncoder().encode(SAMPLE), "contractors-sample.csv", "text/csv")
            }
          >
            Download a sample
          </Button>
        </div>
        <Field id="csv-file" label="Choose a CSV file">
          <input id="csv-file" type="file" accept=".csv,text/csv" onChange={onFile} />
        </Field>
        <Field id="csv-text" label="Or paste it here">
          <textarea
            id="csv-text"
            rows={8}
            value={csv}
            maxLength={MAX_BYTES}
            spellCheck={false}
            onChange={(e) => {
              setCsv(e.target.value);
              setResult(undefined);
            }}
          />
        </Field>
        <div className="sticky-actions">
          <Button onClick={() => void run(false)} disabled={busy}>
            {busy ? "Checking…" : "Check the file"}
          </Button>
          {result && !result.saved && good > 0 ? (
            <Button variant="grey" onClick={() => void run(true)} disabled={busy}>
              Save {good} good row{good === 1 ? "" : "s"}
            </Button>
          ) : null}
        </div>
        {error ? <ErrorNote error={error} /> : null}
      </Card>

      {result ? (
        result.rows.length === 0 ? (
          <EmptyState title="The file has no rows" icon="file">
            Add at least one contractor under the header line.
          </EmptyState>
        ) : (
          <Card className="stack">
            <h2 className="section-title">{result.saved ? "Saved" : "2. Check the result"}</h2>
            <p className="muted">
              {result.saved
                ? `${result.created} added. They wait for your treasury wallet to approve their addresses.`
                : bad === 0
                  ? "Every row is good. Nothing is saved yet."
                  : `${bad} row${bad === 1 ? " has" : "s have"} problems, shown below. Nothing is saved until you choose to.`}
            </p>
            <Table
              caption="Import result"
              rows={result.rows}
              rowKey={(r) => String(r.line)}
              columns={[
                { key: "line", label: "Line", render: (r) => r.line },
                { key: "name", label: "Name", render: (r) => r.name || "(none)" },
                {
                  key: "ok",
                  label: "Result",
                  render: (r) =>
                    r.ok ? <Tag tone="success">Good</Tag> : <Tag tone="error">Problem</Tag>,
                },
                {
                  key: "why",
                  label: "What to fix",
                  render: (r) => (r.problems.length ? r.problems.join(" ") : "Nothing"),
                },
              ]}
            />
          </Card>
        )
      ) : null}
    </div>
  );
}

export function ImportScreen() {
  return (
    <>
      <PageHeader eyebrow="People" title="Import contractors">
        Add many people at once from a spreadsheet.
      </PageHeader>
      <NeedsOrg>{(orgId) => <Import orgId={orgId} />}</NeedsOrg>
    </>
  );
}
