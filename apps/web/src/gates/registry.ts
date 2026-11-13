// Gate B (right recipient): the payee registry from GET /payee-registry, verified in the browser.
// Every approval and the head must be signed by the treasury account itself (L28), with a key that
// NEAR RPC confirms; the set hash is recomputed (L29); the head version can't go below this
// browser's high-water mark; approvals expire after 180 days. Nothing served is trusted as-is:
// messages and hashes are rebuilt from the signed record and compared.
import type { payeeRegistryResponse } from "@veylo/contract";
import {
  canonicalPayeeRecord,
  getPayoutRoute,
  PAYEE_APPROVAL_DAYS,
  PAYEE_SCHEMA,
  PAYOUT_ROUTE_IDS,
  type PayeeRecord,
  type PayoutRouteId,
} from "@veylo/core";
import {
  payeeRecordHash,
  payeeSetHash,
  verifyPayeeApproval,
  verifyRegistryHead,
} from "@veylo/intents";
import { base64 } from "@scure/base";
import type { z } from "zod";
import type { HighWaterStore } from "./high-water.js";
import type { GateRpc } from "./rpc.js";

type Registry = z.infer<typeof payeeRegistryResponse>;

export type VerifiedPayee = {
  readonly approvalId: string;
  readonly record: PayeeRecord;
  readonly recordHash: string;
};

export type VerifiedRegistry =
  | { readonly ok: true; readonly version: number; readonly payees: readonly VerifiedPayee[] }
  | { readonly ok: false; readonly reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Clock skew allowed for a signed timestamp that is ahead of this browser's clock. */
const SKEW_MS = 5 * 60_000;

function decodeNonce(nonce: string): Uint8Array | undefined {
  try {
    const bytes = base64.decode(nonce);
    return bytes.length === 32 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** The signed record, rebuilt from its canonical text; the text must round-trip byte for byte. */
export function parseCanonicalRecord(canonical: string): PayeeRecord | undefined {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(canonical) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (raw.schema !== PAYEE_SCHEMA) return undefined;
  const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const routeId = str("routeId");
  const recipientType = str("recipientType");
  // Digits only, parsed without floating point (money guard): at most 9 digits.
  const versionText = str("version") ?? "";
  const version = /^[1-9]\d{0,8}$/.test(versionText)
    ? [...versionText].reduce((n, c) => n * 10 + (c.charCodeAt(0) - 48), 0)
    : 0;
  const approvedAt = new Date(str("approvedAt") ?? "");
  const expiresAt = new Date(str("expiresAt") ?? "");
  if (!routeId || !(PAYOUT_ROUTE_IDS as readonly string[]).includes(routeId)) return undefined;
  if (recipientType !== "DESTINATION_CHAIN" && recipientType !== "CONFIDENTIAL_INTENTS")
    return undefined;
  if (!Number.isSafeInteger(version) || version < 1) return undefined;
  if (Number.isNaN(approvedAt.getTime()) || Number.isNaN(expiresAt.getTime())) return undefined;
  const record: PayeeRecord = {
    orgId: str("orgId") ?? "",
    contractorId: str("contractorId") ?? "",
    destinationId: str("destinationId") ?? "",
    routeId,
    recipient: str("recipient") ?? "",
    recipientType,
    version,
    approvedAt,
    expiresAt,
  };
  try {
    return canonicalPayeeRecord(record) === canonical ? record : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verifies the whole registry. `treasuryAccountId` is the account the connected wallet controls,
 * never a value served by the API. The high-water mark is raised only after everything verifies.
 */
export async function verifyRegistry(input: {
  orgId: string;
  treasuryAccountId: string;
  authRecipient: string;
  registry: Registry;
  rpc: GateRpc;
  highWater: HighWaterStore;
  now: Date;
}): Promise<VerifiedRegistry> {
  const { orgId, treasuryAccountId, authRecipient, registry, rpc, now } = input;
  const no = (reason: string): VerifiedRegistry => ({ ok: false, reason });
  const head = registry.head;
  if (!head) return no("no registry head");

  // Anti-rollback first: a lower version is refused even if it's validly signed.
  const mark = await input.highWater.get(orgId);
  if (head.version < mark) return no(`registry rollback: head v${head.version} is below v${mark}`);

  if (head.signerAccountId !== treasuryAccountId) return no("head not signed by the treasury");
  if (head.recipient !== authRecipient) return no("head signed for another app");
  const signedAt = new Date(head.signedAt);
  if (Number.isNaN(signedAt.getTime()) || signedAt.getTime() > now.getTime() + SKEW_MS) {
    return no("head signed in the future");
  }
  const recordHashes = head.recordHashes;
  if (new Set(recordHashes).size !== recordHashes.length)
    return no("duplicate entries in the head");
  if (payeeSetHash(recordHashes) !== head.activeSetHash) return no("head set hash doesn't match");
  const headNonce = decodeNonce(head.nonce);
  if (!headNonce) return no("bad head nonce");
  const headSigned = verifyRegistryHead({
    orgId,
    version: head.version,
    recordHashes,
    signedAt,
    nonce: headNonce,
    recipient: authRecipient,
    publicKey: head.ownerPublicKey,
    signature: head.signature,
  });
  if (!headSigned) return no("head signature doesn't verify");
  if (!(await rpc.isAccountKey(treasuryAccountId, head.ownerPublicKey))) {
    return no("head key isn't a full-access key of the treasury (NEAR RPC)");
  }

  const payees: VerifiedPayee[] = [];
  const checkedKeys = new Map<string, boolean>([[head.ownerPublicKey, true]]);
  for (const a of registry.approvals) {
    const record = parseCanonicalRecord(a.canonicalRecord);
    if (!record) return no(`approval ${a.id}: unreadable signed record`);
    if (record.orgId !== orgId) return no(`approval ${a.id}: another org's record`);
    if (record.destinationId !== a.destinationId)
      return no(`approval ${a.id}: destination mismatch`);
    const recordHash = payeeRecordHash(record);
    if (recordHash !== a.recordHash) return no(`approval ${a.id}: record hash mismatch`);
    if (!recordHashes.includes(recordHash)) return no(`approval ${a.id}: not in the head`);
    if (a.ownerAccountId !== treasuryAccountId)
      return no(`approval ${a.id}: not signed by the treasury`);
    if (a.recipient !== authRecipient) return no(`approval ${a.id}: signed for another app`);
    const span = record.expiresAt.getTime() - record.approvedAt.getTime();
    if (span <= 0 || span > PAYEE_APPROVAL_DAYS * DAY_MS) {
      return no(`approval ${a.id}: expiry beyond ${PAYEE_APPROVAL_DAYS} days`);
    }
    if (record.approvedAt.getTime() > now.getTime() + SKEW_MS) {
      return no(`approval ${a.id}: approved in the future`);
    }
    const nonce = decodeNonce(a.nonce);
    if (!nonce) return no(`approval ${a.id}: bad nonce`);
    const signed = verifyPayeeApproval({
      record,
      contractorName: a.contractorName,
      routeLabel: getPayoutRoute(record.routeId as PayoutRouteId).label,
      nonce,
      recipient: authRecipient,
      publicKey: a.ownerPublicKey,
      signature: a.signature,
    });
    if (!signed) return no(`approval ${a.id}: signature doesn't verify`);
    let keyOk = checkedKeys.get(a.ownerPublicKey);
    if (keyOk === undefined) {
      keyOk = await rpc.isAccountKey(treasuryAccountId, a.ownerPublicKey);
      checkedKeys.set(a.ownerPublicKey, keyOk);
    }
    if (!keyOk)
      return no(`approval ${a.id}: key isn't a full-access key of the treasury (NEAR RPC)`);
    payees.push({ approvalId: a.id, record, recordHash });
  }
  // The served approvals must be exactly the head's set: a withheld one could hide a superseded
  // destination (L29), so a gap is a failure, not a skip.
  const served = new Set(payees.map((p) => p.recordHash));
  if (served.size !== payees.length || recordHashes.some((h) => !served.has(h))) {
    return no("the served approvals aren't exactly the head's set");
  }

  await input.highWater.raise(orgId, head.version);
  return { ok: true, version: head.version, payees };
}

/** The payee a quote may pay for one pay-run item, or why there is none. */
export function payeeForItem(
  registry: Extract<VerifiedRegistry, { ok: true }>,
  item: { contractorId: string; destinationId: string | null },
  now: Date,
): { ok: true; payee: VerifiedPayee } | { ok: false; reason: string } {
  if (!item.destinationId) return { ok: false, reason: "the item has no destination" };
  const forContractor = registry.payees.filter((p) => p.record.contractorId === item.contractorId);
  // L29: a superseded-but-signed destination still in the head blocks every payout to this
  // contractor until a new head removes it.
  if (forContractor.some((p) => p.record.destinationId !== item.destinationId)) {
    return { ok: false, reason: "superseded destination still in the registry head" };
  }
  if (forContractor.length > 1) {
    return { ok: false, reason: "more than one signed payee for this destination in the head" };
  }
  const payee = forContractor[0];
  if (!payee) return { ok: false, reason: "no owner-signed payee for this destination" };
  if (payee.record.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "the payee approval has expired" };
  }
  return { ok: true, payee };
}
