// Payee approval and revocation, checked before the treasury wallet signs (L28, L29, T-2). The API
// serves the messages to sign, and T-2 treats it as possibly compromised, so nothing it serves is
// signed as-is: the browser rebuilds both messages from what it shows the owner (contractor, route,
// address) and from the payee registry it has already verified (gate B), and refuses unless they
// match byte for byte. The approved record and the new head set are rebuilt, never read.
import { base64 } from "@scure/base";
import {
  APPROVAL_FIRST_LINE,
  approvalExpiry,
  getPayoutRoute,
  HEAD_FIRST_LINE,
  PAYEE_APPROVAL_DAYS,
  PAYOUT_ROUTE_IDS,
  type PayeeRecord,
  type PayoutRouteId,
} from "@veylo/core";
import { buildApprovalMessage, buildHeadMessage, payeeRecordHash } from "@veylo/intents";
import type { VerifiedPayee } from "../gates/registry";

export class PayeeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayeeRequestError";
  }
}

const SKEW_MS = 5 * 60_000;
/** The API's request lifetime for payee requests: an approval can't be older than this. */
const REQUEST_TTL_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Most of one contractor's entries the head check will try dropping (2^8 sets). */
const MAX_OWN_ENTRIES = 8;

/** The registry as the browser verified it. Version 0 with no payees: no head exists yet. */
export type CurrentRegistry = { version: number; payees: readonly VerifiedPayee[] };

function nonce(value: string): Uint8Array {
  try {
    const bytes = base64.decode(value);
    if (bytes.length === 32) return bytes;
  } catch {
    // fall through
  }
  throw new PayeeRequestError("bad nonce");
}

function fields(message: string, first: string, labels: readonly string[]): string[] {
  const lines = message.split("\n");
  if (lines.length !== labels.length + 1 || lines[0] !== first)
    throw new PayeeRequestError(`not a "${first}" message`);
  return labels.map((label, i) => {
    const line = lines[i + 1] ?? "";
    if (!line.startsWith(`${label}: `)) throw new PayeeRequestError(`missing ${label}`);
    return line.slice(label.length + 2);
  });
}

function positive(text: string): number {
  if (!/^[1-9]\d{0,8}$/.test(text)) throw new PayeeRequestError("bad version");
  return [...text].reduce((n, c) => n * 10 + (c.charCodeAt(0) - 48), 0);
}

function isoDate(text: string): Date {
  const d = new Date(text);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== text)
    throw new PayeeRequestError("bad timestamp");
  return d;
}

/** The new head's set must be the current set, minus some of this contractor's own entries. */
function checkHead(input: {
  headMessage: string;
  orgId: string;
  current: CurrentRegistry;
  keep: readonly string[];
  droppable: readonly string[];
  add: string | undefined;
  now: Date;
}): void {
  const [org, versionText, , , signedText] = fields(input.headMessage, HEAD_FIRST_LINE, [
    "Org",
    "Version",
    "Active payees",
    "Set",
    "Signed",
  ]);
  if (org !== input.orgId) throw new PayeeRequestError("the head is for another org");
  const version = positive(versionText ?? "");
  if (version !== input.current.version + 1)
    throw new PayeeRequestError(`the head must be version ${input.current.version + 1}`);
  const signedAt = isoDate(signedText ?? "");
  if (Math.abs(signedAt.getTime() - input.now.getTime()) > REQUEST_TTL_MS + SKEW_MS)
    throw new PayeeRequestError("the head isn't current");
  if (input.droppable.length > MAX_OWN_ENTRIES)
    throw new PayeeRequestError("too many entries to check");
  for (let mask = 0; mask < 1 << input.droppable.length; mask += 1) {
    const kept = input.droppable.filter((_, i) => (mask & (1 << i)) === 0);
    const set = [...input.keep, ...kept, ...(input.add ? [input.add] : [])];
    if (new Set(set).size !== set.length) continue;
    const expected = buildHeadMessage({
      orgId: input.orgId,
      version,
      recordHashes: set,
      signedAt,
    });
    if (expected === input.headMessage) return;
  }
  throw new PayeeRequestError("the new payee list isn't the verified list with this one change");
}

/** Returns the nonces to sign with, or throws. */
export function checkApprovalRequest(
  request: {
    approvalMessage: string;
    approvalNonce: string;
    headMessage: string;
    headNonce: string;
    recipient: string;
  },
  ctx: {
    orgId: string;
    authRecipient: string;
    contractor: { id: string; name: string };
    destination: { id: string; route: string; address: string };
    current: CurrentRegistry;
    now: Date;
  },
): { approvalNonce: Uint8Array; headNonce: Uint8Array; recordHash: string } {
  if (request.recipient !== ctx.authRecipient)
    throw new PayeeRequestError("signed for another app");
  if (!(PAYOUT_ROUTE_IDS as readonly string[]).includes(ctx.destination.route))
    throw new PayeeRequestError("unknown route");
  const route = getPayoutRoute(ctx.destination.route as PayoutRouteId);
  const [org, contractor, payTo, routeLabel, recipientType, versionText, expiresText] = fields(
    request.approvalMessage,
    APPROVAL_FIRST_LINE,
    ["Org", "Contractor", "Pay to", "Route", "Recipient type", "Version", "Expires", "Record"],
  );
  if (org !== ctx.orgId) throw new PayeeRequestError("the approval is for another org");
  if (contractor !== `${ctx.contractor.name} (${ctx.contractor.id})`)
    throw new PayeeRequestError("the approval names another contractor");
  if (payTo !== ctx.destination.address)
    throw new PayeeRequestError("the approval pays another address");
  if (routeLabel !== route.label || recipientType !== route.recipientType)
    throw new PayeeRequestError("the approval is for another route");
  const expiresAt = isoDate(expiresText ?? "");
  const approvedAt = new Date(expiresAt.getTime() - PAYEE_APPROVAL_DAYS * DAY_MS);
  if (approvalExpiry(approvedAt).getTime() !== expiresAt.getTime())
    throw new PayeeRequestError("bad expiry");
  const age = ctx.now.getTime() - approvedAt.getTime();
  if (age < -SKEW_MS || age > REQUEST_TTL_MS + SKEW_MS)
    throw new PayeeRequestError("the approval isn't current");
  const record: PayeeRecord = {
    orgId: ctx.orgId,
    contractorId: ctx.contractor.id,
    destinationId: ctx.destination.id,
    routeId: route.id,
    recipient: ctx.destination.address,
    recipientType: route.recipientType,
    version: positive(versionText ?? ""),
    approvedAt,
    expiresAt,
  };
  const rebuilt = buildApprovalMessage({
    record,
    contractorName: ctx.contractor.name,
    routeLabel: route.label,
  });
  if (rebuilt !== request.approvalMessage)
    throw new PayeeRequestError("the approval doesn't match the rebuilt record");
  const recordHash = payeeRecordHash(record);

  const own = ctx.current.payees.filter((p) => p.record.contractorId === ctx.contractor.id);
  checkHead({
    headMessage: request.headMessage,
    orgId: ctx.orgId,
    current: ctx.current,
    keep: ctx.current.payees
      .filter((p) => p.record.contractorId !== ctx.contractor.id)
      .map((p) => p.recordHash),
    droppable: own.map((p) => p.recordHash),
    add: recordHash,
    now: ctx.now,
  });
  return {
    approvalNonce: nonce(request.approvalNonce),
    headNonce: nonce(request.headNonce),
    recordHash,
  };
}

/** Revoking one approval: the new head is the verified set without exactly that entry. */
export function checkRevokeRequest(
  request: { headMessage: string; headNonce: string; recipient: string },
  ctx: {
    orgId: string;
    authRecipient: string;
    approvalId: string;
    current: CurrentRegistry;
    now: Date;
  },
): { headNonce: Uint8Array } {
  if (request.recipient !== ctx.authRecipient)
    throw new PayeeRequestError("signed for another app");
  const target = ctx.current.payees.find((p) => p.approvalId === ctx.approvalId);
  if (!target) throw new PayeeRequestError("that approval isn't in the verified payee list");
  checkHead({
    headMessage: request.headMessage,
    orgId: ctx.orgId,
    current: ctx.current,
    keep: ctx.current.payees.filter((p) => p !== target).map((p) => p.recordHash),
    droppable: [],
    add: undefined,
    now: ctx.now,
  });
  return { headNonce: nonce(request.headNonce) };
}
