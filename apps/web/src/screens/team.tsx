"use client";
// Team and roles (slice W6): who can do what. An owner approves payees and payouts with the treasury
// wallet; a preparer makes drafts and contractors; an accountant reads the ledger, payslips,
// statements and CSV; a viewer sees the basics. Roles are enforced by the API, not just hidden here.
import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { LoadBlock } from "../app-ui/page-kit";
import { NeedsOrg, PageHeader, ErrorNote } from "../app-ui/shell";
import { useApi, useOrg, useSession } from "../app-ui/session";
import { Button, Field, fieldAria, Tag } from "../ui/basic";
import { Table } from "../ui/data";
import { Card, Modal, useToast } from "../ui/interactive";

const ROLES = [
  ["owner", "Owner", "Approves payees and payouts with the treasury wallet. Manages the team."],
  ["preparer", "Preparer", "Makes contractors and drafts. Cannot approve or sign."],
  ["accountant", "Accountant", "Reads the ledger, payslips, statements, CSV and audit log."],
  ["viewer", "Viewer", "Sees contractors and pay runs, nothing personal."],
] as const;
type Role = (typeof ROLES)[number][0];

function Team({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  const { api, me } = useSession();
  const toast = useToast();
  const q = useApi(() => api.call("GET /orgs/:orgId/members", { params: { orgId } }), [orgId]);
  const [who, setWho] = useState("");
  const [role, setRole] = useState<Role>("preparer");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<{ userId: string; label: string }>();

  async function add(e: FormEvent) {
    e.preventDefault();
    const value = who.trim();
    if (!value) return setError("Enter their email or their NEAR account.");
    setBusy(true);
    setError(undefined);
    try {
      await api.call("POST /orgs/:orgId/members", {
        params: { orgId },
        body: value.includes("@") ? { email: value, role } : { nearAccountId: value, role },
      });
      toast("success", "Added to your team.");
      setWho("");
      q.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add them. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function change(userId: string, next: Role) {
    try {
      await api.call("PATCH /orgs/:orgId/members/:userId", {
        params: { orgId, userId },
        body: { role: next },
      });
      toast("success", "Role changed.");
      q.reload();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Couldn't change the role.");
      q.reload();
    }
  }

  async function remove() {
    if (!removing) return;
    try {
      await api.call("POST /orgs/:orgId/members/:userId/remove", {
        params: { orgId, userId: removing.userId },
        body: {},
      });
      toast("success", "Removed.");
      setRemoving(undefined);
      q.reload();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Couldn't remove them.");
      setRemoving(undefined);
    }
  }

  return (
    <div className="stack">
      <LoadBlock
        query={q}
        label="your team"
        isEmpty={(d) => d.members.length === 0}
        empty={{ title: "No team members", body: "People you add appear here.", icon: "users" }}
      >
        {(d) => (
          <Table
            caption="Team"
            rows={d.members}
            rowKey={(m) => m.userId}
            columns={[
              {
                key: "who",
                label: "Member",
                render: (m) => (
                  <span className="mono">{m.email ?? m.nearAccountId ?? "Unknown"}</span>
                ),
              },
              {
                key: "role",
                label: "Role",
                render: (m) =>
                  isOwner ? (
                    <select
                      aria-label={`Role for ${m.email ?? m.nearAccountId}`}
                      value={m.role}
                      onChange={(e) => void change(m.userId, e.target.value as Role)}
                    >
                      {ROLES.map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Tag tone="neutral">{m.role}</Tag>
                  ),
              },
              {
                key: "act",
                label: "",
                render: (m) =>
                  isOwner && m.userId !== me?.user.id ? (
                    <Button
                      variant="grey"
                      small
                      onClick={() =>
                        setRemoving({
                          userId: m.userId,
                          label: m.email ?? m.nearAccountId ?? "this member",
                        })
                      }
                    >
                      Remove
                    </Button>
                  ) : (
                    <span className="small muted">{m.userId === me?.user.id ? "You" : ""}</span>
                  ),
              },
            ]}
          />
        )}
      </LoadBlock>

      {isOwner ? (
        <Card>
          <form className="form" onSubmit={add} noValidate>
            <h2 className="section-title">Add someone</h2>
            <div className="form-row">
              <Field
                id="member-who"
                label="Their email or NEAR account"
                hint="An email works if they already have a Veylo account."
                error={error}
              >
                <input
                  {...fieldAria("member-who", "hint", error)}
                  value={who}
                  maxLength={254}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setWho(e.target.value)}
                />
              </Field>
              <Field id="member-role" label="Role">
                <select
                  id="member-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  {ROLES.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding…" : "Add to team"}
            </Button>
          </form>
        </Card>
      ) : (
        <p className="muted small">Only an owner can add or change team members.</p>
      )}

      <Card className="stack">
        <h2 className="section-title">What each role can do</h2>
        <dl className="kv">
          {ROLES.map(([id, label, text]) => (
            <div key={id} className="kv-row">
              <dt>{label}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Modal
        open={removing !== undefined}
        title="Remove from the team?"
        onClose={() => setRemoving(undefined)}
        actions={<Button onClick={remove}>Remove</Button>}
      >
        <p>
          {removing?.label} will lose access to this organisation. Their past actions stay in the
          audit log.
        </p>
      </Modal>
      {error && !isOwner ? <ErrorNote error={error} /> : null}
    </div>
  );
}

export function TeamScreen() {
  const role = useOrg()?.role;
  return (
    <>
      <PageHeader eyebrow="Organisation" title="Team and roles">
        Who can prepare, approve and read.
      </PageHeader>
      <NeedsOrg>{(orgId) => <Team orgId={orgId} isOwner={role === "owner"} />}</NeedsOrg>
    </>
  );
}
