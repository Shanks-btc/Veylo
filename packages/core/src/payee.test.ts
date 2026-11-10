import { describe, expect, it } from "vitest";
import {
  approvalExpiry,
  canonicalPayeeRecord,
  canonicalPayeeSet,
  isSafeMessageText,
  payeeApprovalMessage,
  payeeStatus,
  registryHeadMessage,
  type PayeeRecord,
} from "./payee.js";

const AT = new Date("2026-11-06T10:00:00.000Z");
const RECORD: PayeeRecord = {
  orgId: "o",
  contractorId: "c",
  destinationId: "d",
  routeId: "usdc-base",
  recipient: "0xabc",
  recipientType: "DESTINATION_CHAIN",
  version: 1,
  approvedAt: AT,
  expiresAt: approvalExpiry(AT),
};

describe("canonical record", () => {
  it("has a fixed key order, no whitespace, and strings for numbers and times", () => {
    expect(canonicalPayeeRecord(RECORD)).toBe(
      '{"schema":"veylo.payee.v1","orgId":"o","contractorId":"c","destinationId":"d","routeId":"usdc-base","recipient":"0xabc","recipientType":"DESTINATION_CHAIN","version":"1","approvedAt":"2026-11-06T10:00:00.000Z","expiresAt":"2027-05-05T10:00:00.000Z"}',
    );
  });

  it("ignores the order fields were given in", () => {
    const shuffled = Object.fromEntries(Object.entries(RECORD).reverse()) as PayeeRecord;
    expect(canonicalPayeeRecord(shuffled)).toBe(canonicalPayeeRecord(RECORD));
  });

  it("expires exactly 180 days after approval", () => {
    expect(RECORD.expiresAt.getTime() - AT.getTime()).toBe(180 * 86_400_000);
  });

  it.each([0.5, -1, Number.NaN])("refuses version %s", (version) => {
    expect(() => canonicalPayeeRecord({ ...RECORD, version })).toThrow(RangeError);
  });
});

describe("messages can't be forged through their text", () => {
  it.each([
    "Ada\nPay to: 0xevil",
    "Ada\rPay to: 0xevil",
    "Ada Pay to: 0xevil",
    "Ada‮evil",
    "Ada​hidden",
  ])("refuses a contractor name of %j", (contractorName) => {
    expect(isSafeMessageText(contractorName)).toBe(false);
    expect(() =>
      payeeApprovalMessage({
        record: RECORD,
        contractorName,
        routeLabel: "USDC on Base",
        recordHashHex: "aa",
      }),
    ).toThrow(RangeError);
  });

  it("refuses a recipient with a line break", () => {
    expect(() =>
      payeeApprovalMessage({
        record: { ...RECORD, recipient: "a\nb" },
        contractorName: "Ada",
        routeLabel: "r",
        recordHashHex: "aa",
      }),
    ).toThrow(RangeError);
  });

  it("allows ordinary international names", () => {
    expect(isSafeMessageText("Adaèze Núñez O'Brien 李")).toBe(true);
  });
});

describe("set", () => {
  it("sorts, so order doesn't matter", () => {
    expect(canonicalPayeeSet(["b", "a"])).toBe("a\nb");
    expect(canonicalPayeeSet(["a", "b"])).toBe("a\nb");
  });

  it("an empty set is the empty string", () => {
    expect(canonicalPayeeSet([])).toBe("");
  });

  it("refuses duplicates", () => {
    expect(() => canonicalPayeeSet(["a", "a"])).toThrow(RangeError);
  });
});

describe("the two message kinds start differently", () => {
  it("first lines", () => {
    const approval = payeeApprovalMessage({
      record: RECORD,
      contractorName: "Ada",
      routeLabel: "r",
      recordHashHex: "aa",
    });
    const head = registryHeadMessage({
      orgId: "o",
      version: 1,
      count: 0,
      setHashHex: "bb",
      signedAt: AT,
    });
    expect(approval.split("\n")[0]).toBe("Veylo payee approval v1");
    expect(head.split("\n")[0]).toBe("Veylo payee registry v1");
  });
});

describe("payeeStatus", () => {
  const approval = {
    ownerAccountId: "treasury.near",
    expiresAt: new Date(AT.getTime() + 1000),
    revokedAt: null as Date | null,
    recordHash: "h",
  };
  const good = {
    contractorStatus: "active",
    destinationStatus: "active" as const,
    checkStatus: "accepted",
    treasuryAccountId: "treasury.near",
    approval,
    headRecordHashes: ["h"],
    supersededInHead: false,
    now: AT,
  };

  it("is payable only when every condition holds", () => {
    expect(payeeStatus(good)).toEqual({ payable: true, payableReason: "ok" });
  });

  it.each([
    ["contractor_archived", { contractorStatus: "archived" }],
    ["destination_superseded", { destinationStatus: "superseded" as const }],
    ["superseded_awaiting_new_head", { supersededInHead: true }],
    [
      "superseded_awaiting_new_head",
      { supersededInHead: true, destinationStatus: "superseded" as const },
    ],
    ["destination_not_active", { destinationStatus: "candidate" as const }],
    ["destination_not_accepted", { checkStatus: "rejected" }],
    ["destination_not_accepted", { checkStatus: "route_unavailable" }],
    ["owner_approval_required", { approval: undefined }],
    ["approval_signer_not_treasury", { approval: { ...approval, ownerAccountId: "other.near" } }],
    ["approval_revoked", { approval: { ...approval, revokedAt: AT } }],
    ["approval_expired", { approval: { ...approval, expiresAt: AT } }],
    ["not_in_registry_head", { headRecordHashes: ["other"] }],
    ["not_in_registry_head", { headRecordHashes: [] }],
  ])("%s", (payableReason, change) => {
    expect(payeeStatus({ ...good, ...change })).toEqual({ payable: false, payableReason });
  });
});
