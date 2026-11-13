// Payee approval and revoke requests are rebuilt in the browser before the wallet signs them.
import { base64 } from "@scure/base";
import { approvalExpiry, getPayoutRoute, type PayeeRecord } from "@veylo/core";
import { buildApprovalMessage, buildHeadMessage, payeeRecordHash } from "@veylo/intents";
import { describe, expect, it } from "vitest";
import { checkApprovalRequest, checkRevokeRequest, type CurrentRegistry } from "./payee-requests";

const ORG = "11111111-1111-4111-8111-111111111111";
const AUTH = "veylo.app";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const NONCE = base64.encode(new Uint8Array(32).fill(7));
const ADA = { id: "22222222-2222-4222-8222-222222222222", name: "Ada Lovelace" };
const DEST = {
  id: "33333333-3333-4333-8333-333333333333",
  route: "usdc-near-confidential",
  address: "ada-l.near",
};

function rec(over: Partial<PayeeRecord> = {}): PayeeRecord {
  const route = getPayoutRoute((over.routeId ?? DEST.route) as never);
  const approvedAt = over.approvedAt ?? new Date(NOW.getTime() - 60_000);
  return {
    orgId: ORG,
    contractorId: ADA.id,
    destinationId: DEST.id,
    routeId: route.id,
    recipient: DEST.address,
    recipientType: route.recipientType,
    version: 1,
    approvedAt,
    expiresAt: approvalExpiry(approvedAt),
    ...over,
  };
}

const other = rec({
  contractorId: "44444444-4444-4444-8444-444444444444",
  destinationId: "55555555-5555-4555-8555-555555555555",
  recipient: "kwame.near",
});
const current: CurrentRegistry = {
  version: 4,
  payees: [{ approvalId: "a-other", record: other, recordHash: payeeRecordHash(other) }],
};

function request(record = rec(), set?: string[], version = 5) {
  const route = getPayoutRoute(record.routeId as never);
  return {
    approvalMessage: buildApprovalMessage({
      record,
      contractorName: ADA.name,
      routeLabel: route.label,
    }),
    approvalNonce: NONCE,
    headMessage: buildHeadMessage({
      orgId: ORG,
      version,
      recordHashes: set ?? [payeeRecordHash(other), payeeRecordHash(record)],
      signedAt: NOW,
    }),
    headNonce: NONCE,
    recipient: AUTH,
  };
}
const ctx = {
  orgId: ORG,
  authRecipient: AUTH,
  contractor: ADA,
  destination: DEST,
  current,
  now: NOW,
};

describe("checkApprovalRequest", () => {
  it("accepts the request the API builds", () => {
    expect(checkApprovalRequest(request(), ctx).recordHash).toBe(payeeRecordHash(rec()));
  });
  it("refuses another address", () => {
    expect(() => checkApprovalRequest(request(rec({ recipient: "mallory.near" })), ctx)).toThrow(
      /another address/,
    );
  });
  it("refuses another app", () => {
    expect(() => checkApprovalRequest({ ...request(), recipient: "evil.app" }, ctx)).toThrow(
      /another app/,
    );
  });
  it("refuses a head that drops another contractor", () => {
    expect(() => checkApprovalRequest(request(rec(), [payeeRecordHash(rec())]), ctx)).toThrow(
      /payee list/,
    );
  });
  it("refuses a head that adds someone else", () => {
    const extra = payeeRecordHash(rec({ recipient: "x.near", destinationId: "d" }));
    expect(() =>
      checkApprovalRequest(
        request(rec(), [payeeRecordHash(other), payeeRecordHash(rec()), extra]),
        ctx,
      ),
    ).toThrow(/payee list/);
  });
  it("refuses a head version that isn't the next one", () => {
    expect(() => checkApprovalRequest(request(rec(), undefined, 9), ctx)).toThrow(/version 5/);
  });
  it("refuses an approval that isn't current", () => {
    const old = rec({ approvedAt: new Date(NOW.getTime() - 3_600_000) });
    expect(() => checkApprovalRequest(request(old), ctx)).toThrow(/current/);
  });
});

describe("checkRevokeRequest", () => {
  const revoke = (set: string[], version = 5) => ({
    headMessage: buildHeadMessage({ orgId: ORG, version, recordHashes: set, signedAt: NOW }),
    headNonce: NONCE,
    recipient: AUTH,
  });
  const rctx = { orgId: ORG, authRecipient: AUTH, approvalId: "a-other", current, now: NOW };
  it("accepts the list without exactly that approval", () => {
    expect(() => checkRevokeRequest(revoke([]), rctx)).not.toThrow();
  });
  it("refuses a list that keeps it or swaps in another", () => {
    expect(() => checkRevokeRequest(revoke([payeeRecordHash(other)]), rctx)).toThrow();
    expect(() => checkRevokeRequest(revoke([payeeRecordHash(rec())]), rctx)).toThrow();
  });
  it("refuses an approval that isn't in the verified list", () => {
    expect(() => checkRevokeRequest(revoke([]), { ...rctx, approvalId: "nope" })).toThrow(
      /verified/,
    );
  });
});
