"use client";
// Payroll schedules (slice W6): pay on the same day each month, or every two weeks. Three days
// before payday the worker prepares a draft and marks it "Ready for review". It never quotes, signs
// or sends anything: you open the draft, your browser checks it, and you approve each payout in your
// wallet. Dates are days in your organisation's time zone, so daylight saving and month ends are safe.
import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { Facts, LoadBlock, Saved } from "../app-ui/page-kit";
import { ErrorNote, NeedsOrg, PageHeader } from "../app-ui/shell";
import { useApi, useOrg, useSession } from "../app-ui/session";
import { Button, Field, fieldAria, Tag } from "../ui/basic";
import { Card, useToast } from "../ui/interactive";

function Schedule({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const { api } = useSession();
  const toast = useToast();
  const q = useApi(
    () => api.call("GET /orgs/:orgId/payroll-schedule", { params: { orgId } }),
    [orgId],
  );
  const settings = useApi(
    () => api.call("GET /orgs/:orgId/settings", { params: { orgId } }),
    [orgId],
  );
  const [kind, setKind] = useState<"monthly" | "biweekly">("monthly");
  const [day, setDay] = useState("25");
  const [anchor, setAnchor] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const zone = settings.data?.timeZone ?? "UTC";

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSaved(false);
    let body;
    if (kind === "monthly") {
      const d = day.trim();
      if (!/^\d{1,2}$/.test(d) || d === "0" || d.length > 2)
        return setError("Enter a day of the month from 1 to 31.");
      // A digit string of one or two characters, read without a float parse.
      const n = [...d].reduce((acc, ch) => acc * 10 + (ch.charCodeAt(0) - 48), 0);
      if (n < 1 || n > 31) return setError("Enter a day of the month from 1 to 31.");
      body = { kind: "monthly" as const, dayOfMonth: n, timeZone: zone };
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return setError("Pick the date of the next payday.");
      body = { kind: "biweekly" as const, anchorDate: anchor, timeZone: zone };
    }
    setBusy(true);
    try {
      await api.call("PUT /orgs/:orgId/payroll-schedule", { params: { orgId }, body });
      setSaved(true);
      toast("success", "Schedule saved.");
      q.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the schedule. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(action: "pause" | "resume") {
    try {
      await api.call(
        action === "pause"
          ? "POST /orgs/:orgId/payroll-schedule/pause"
          : "POST /orgs/:orgId/payroll-schedule/resume",
        {
          params: { orgId },
          body: {},
        },
      );
      toast("success", action === "pause" ? "Schedule paused." : "Schedule resumed.");
      q.reload();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Couldn't change the schedule.");
    }
  }

  return (
    <div className="stack">
      <LoadBlock query={q} label="your schedule" lines={3}>
        {(d) =>
          d.schedule ? (
            <Card className="stack">
              <div className="spread">
                <h2 className="section-title">Your schedule</h2>
                <Tag tone={d.schedule.paused ? "warning" : "success"}>
                  {d.schedule.paused ? "Paused" : "Running"}
                </Tag>
              </div>
              <Facts
                rows={[
                  [
                    "Repeats",
                    d.schedule.kind === "monthly"
                      ? `Monthly, on day ${d.schedule.dayOfMonth}`
                      : `Every two weeks from ${d.schedule.anchorDate}`,
                  ],
                  ["Time zone", d.schedule.timeZone],
                  ["Next payday", d.next ? d.next.payday : "None coming up"],
                  ["Draft prepared on", d.next ? d.next.prepareOn : "None coming up"],
                ]}
              />
              {canEdit ? (
                <div className="actions">
                  {d.schedule.paused ? (
                    <Button variant="grey" onClick={() => toggle("resume")}>
                      Resume
                    </Button>
                  ) : (
                    <Button variant="grey" onClick={() => toggle("pause")}>
                      Pause
                    </Button>
                  )}
                </div>
              ) : null}
            </Card>
          ) : (
            <Card className="stack">
              <h2 className="section-title">No schedule yet</h2>
              <p className="muted">
                Set one and Veylo prepares a draft pay run three days before each payday. You still
                review and approve everything yourself.
              </p>
            </Card>
          )
        }
      </LoadBlock>

      {canEdit ? (
        <Card>
          <form className="form" onSubmit={save} noValidate>
            <h2 className="section-title">Set the schedule</h2>
            <Field id="sch-kind" label="Pay">
              <select
                id="sch-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as "monthly" | "biweekly")}
              >
                <option value="monthly">Once a month</option>
                <option value="biweekly">Every two weeks</option>
              </select>
            </Field>
            {kind === "monthly" ? (
              <Field
                id="sch-day"
                label="Day of the month"
                hint="A day past the end of a short month is paid on its last day."
                error={error}
              >
                <input
                  {...fieldAria("sch-day", "hint", error)}
                  inputMode="numeric"
                  value={day}
                  maxLength={2}
                  onChange={(e) => setDay(e.target.value)}
                />
              </Field>
            ) : (
              <Field id="sch-anchor" label="First payday" error={error}>
                <input
                  {...fieldAria("sch-anchor", undefined, error)}
                  type="date"
                  value={anchor}
                  onChange={(e) => setAnchor(e.target.value)}
                />
              </Field>
            )}
            <p className="small muted">
              Time zone: {zone}. Change it in <a href="/app/settings">Settings</a>.
            </p>
            <div className="sticky-actions">
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save schedule"}
              </Button>
            </div>
            {saved ? (
              <Saved>Saved. The next draft will be prepared three days before payday.</Saved>
            ) : null}
          </form>
        </Card>
      ) : (
        <p className="muted small">Only an owner can change the schedule.</p>
      )}

      <Card className="stack">
        <h2 className="section-title">What the schedule does, and doesn&apos;t</h2>
        <ul className="list-plain">
          <li>
            It prepares a draft three days before payday and marks it &ldquo;Ready for
            review&rdquo;.
          </li>
          <li>It never asks for a price, never signs and never sends money.</li>
          <li>You open the draft, check it, and approve each payout in your wallet.</li>
        </ul>
      </Card>
      {error && !/day|payday/i.test(error) ? <ErrorNote error={error} /> : null}
    </div>
  );
}

export function SchedulesScreen() {
  const role = useOrg()?.role;
  return (
    <>
      <PageHeader eyebrow="Money" title="Payroll schedules">
        Pay on the same day every month, or every two weeks.
      </PageHeader>
      <NeedsOrg>{(orgId) => <Schedule orgId={orgId} canEdit={role === "owner"} />}</NeedsOrg>
    </>
  );
}
