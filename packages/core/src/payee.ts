// Canonical payee messages (ARCHITECTURE §6.2 step 5, §6.3 gate B). Pure, so the browser can reuse it.
// Hashing lives in @veylo/intents, because core has no dependencies: functions here take finished
// hex hashes. These bytes are signed, so any change to them needs a new schema version.

export const PAYEE_SCHEMA = "veylo.payee.v1";
export const PAYEE_APPROVAL_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

export type PayeeRecord = {
  readonly orgId: string;
  readonly contractorId: string;
  readonly destinationId: string;
  readonly routeId: string;
  readonly recipient: string;
  readonly recipientType: "DESTINATION_CHAIN" | "CONFIDENTIAL_INTENTS";
  /** Per destination, from 1. */
  readonly version: number;
  readonly approvedAt: Date;
  readonly expiresAt: Date;
};

export const approvalExpiry = (approvedAt: Date): Date =>
  new Date(approvedAt.getTime() + PAYEE_APPROVAL_DAYS * DAY_MS);

function positiveInteger(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`bad ${name}`);
  return value.toString();
}

/** A line break or invisible character in a signed message could forge or hide a line. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
export const isSafeMessageText = (text: string): boolean => !UNSAFE_TEXT.test(text);

function line(label: string, value: string): string {
  if (!isSafeMessageText(value)) throw new RangeError(`unsafe text in ${label}`);
  return `${label}: ${value}`;
}

/** Fixed key order, no whitespace, integers and timestamps as strings. */
export function canonicalPayeeRecord(record: PayeeRecord): string {
  return JSON.stringify({
    schema: PAYEE_SCHEMA,
    orgId: record.orgId,
    contractorId: record.contractorId,
    destinationId: record.destinationId,
    routeId: record.routeId,
    recipient: record.recipient,
    recipientType: record.recipientType,
    version: positiveInteger(record.version, "version"),
    approvedAt: record.approvedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  });
}

export const APPROVAL_FIRST_LINE = "Veylo payee approval v1";
export const HEAD_FIRST_LINE = "Veylo payee registry v1";

export function payeeApprovalMessage(input: {
  record: PayeeRecord;
  contractorName: string;
  routeLabel: string;
  recordHashHex: string;
}): string {
  const { record } = input;
  return [
    APPROVAL_FIRST_LINE,
    line("Org", record.orgId),
    line("Contractor", `${input.contractorName} (${record.contractorId})`),
    line("Pay to", record.recipient),
    line("Route", input.routeLabel),
    line("Recipient type", record.recipientType),
    line("Version", positiveInteger(record.version, "version")),
    line("Expires", record.expiresAt.toISOString()),
    line("Record", `sha256:${input.recordHashHex}`),
  ].join("\n");
}

/** What the set hash covers: the record hashes, sorted, one per line. An empty set is "". */
export function canonicalPayeeSet(recordHashes: readonly string[]): string {
  const sorted = [...recordHashes].sort();
  if (new Set(sorted).size !== sorted.length) throw new RangeError("duplicate record hash");
  return sorted.join("\n");
}

export function registryHeadMessage(input: {
  orgId: string;
  version: number;
  count: number;
  setHashHex: string;
  signedAt: Date;
}): string {
  return [
    HEAD_FIRST_LINE,
    line("Org", input.orgId),
    line("Version", positiveInteger(input.version, "version")),
    line("Active payees", positiveInteger(input.count, "count")),
    line("Set", `sha256:${input.setHashHex}`),
    line("Signed", input.signedAt.toISOString()),
  ].join("\n");
}

export type PayableReason =
  | "ok"
  | "contractor_archived"
  | "superseded_awaiting_new_head"
  | "destination_superseded"
  | "destination_not_active"
  | "destination_not_accepted"
  | "owner_approval_required"
  | "approval_signer_not_treasury"
  | "approval_revoked"
  | "approval_expired"
  | "not_in_registry_head";

/** The server's view, for display. The browser re-verifies signatures before any payout (L16). */
export function payeeStatus(input: {
  contractorStatus: string;
  destinationStatus: "candidate" | "active" | "superseded";
  checkStatus: string;
  treasuryAccountId: string;
  /** The destination's highest-version approval, if any. */
  approval?: {
    ownerAccountId: string;
    expiresAt: Date;
    revokedAt: Date | null;
    recordHash: string;
  };
  headRecordHashes: readonly string[];
  /** This contractor has an approval for a superseded destination still in the head's set (L29). */
  supersededInHead: boolean;
  now: Date;
}): { payable: boolean; payableReason: PayableReason } {
  const no = (payableReason: PayableReason) => ({ payable: false, payableReason });
  if (input.contractorStatus !== "active") return no("contractor_archived");
  // Until a new head removes it, a signed record still points at the old address, so the browser
  // would accept that recipient. Nothing for this contractor is paid until the owner signs (L29).
  if (input.supersededInHead) return no("superseded_awaiting_new_head");
  if (input.destinationStatus === "superseded") return no("destination_superseded");
  if (input.checkStatus !== "accepted") return no("destination_not_accepted");
  if (input.destinationStatus !== "active") return no("destination_not_active");
  const { approval } = input;
  if (!approval) return no("owner_approval_required");
  if (approval.ownerAccountId !== input.treasuryAccountId) {
    return no("approval_signer_not_treasury");
  }
  if (approval.revokedAt !== null) return no("approval_revoked");
  if (approval.expiresAt.getTime() <= input.now.getTime()) return no("approval_expired");
  if (!input.headRecordHashes.includes(approval.recordHash)) return no("not_in_registry_head");
  return { payable: true, payableReason: "ok" };
}
