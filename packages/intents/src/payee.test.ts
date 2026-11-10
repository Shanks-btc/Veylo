import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import {
  approvalExpiry,
  canonicalPayeeRecord,
  canonicalPayeeSet,
  type PayeeRecord,
} from "@veylo/core";
import { describe, expect, it } from "vitest";
import {
  buildApprovalMessage,
  buildHeadMessage,
  hashNep413,
  payeeRecordHash,
  payeeSetHash,
  verifyNep413,
  verifyPayeeApproval,
  verifyRegistryHead,
} from "./index.js";

// A key made only for these vectors. It controls nothing.
const SECRET = new Uint8Array(32).fill(7);
const PUBLIC_KEY = `ed25519:${base58.encode(ed25519.getPublicKey(SECRET))}`;
const RECIPIENT = "veylo.app";
const NONCE_A = new Uint8Array(32).fill(1);
const NONCE_B = new Uint8Array(32).fill(2);

const sign = (message: string, nonce: Uint8Array, recipient = RECIPIENT) =>
  base64.encode(ed25519.sign(hashNep413({ message, nonce, recipient }), SECRET));

const APPROVED_AT = new Date("2026-11-06T10:00:00.000Z");
const RECORD: PayeeRecord = {
  orgId: "11111111-1111-4111-8111-111111111111",
  contractorId: "22222222-2222-4222-8222-222222222222",
  destinationId: "33333333-3333-4333-8333-333333333333",
  routeId: "usdc-base",
  recipient: "0xAf780910c0E7D41430D4615A437676a87a332C8C",
  recipientType: "DESTINATION_CHAIN",
  version: 1,
  approvedAt: APPROVED_AT,
  expiresAt: approvalExpiry(APPROVED_AT),
};
const NAME = "Ada Lovelace";
const LABEL = "USDC on Base";
const SECOND_HASH = "b".repeat(64);

const GOLDEN = {
  canonical:
    '{"schema":"veylo.payee.v1","orgId":"11111111-1111-4111-8111-111111111111","contractorId":"22222222-2222-4222-8222-222222222222","destinationId":"33333333-3333-4333-8333-333333333333","routeId":"usdc-base","recipient":"0xAf780910c0E7D41430D4615A437676a87a332C8C","recipientType":"DESTINATION_CHAIN","version":"1","approvedAt":"2026-11-06T10:00:00.000Z","expiresAt":"2027-05-05T10:00:00.000Z"}',
  recordHash: "e043a6e73e11a11edc0f5e2180f46f1e13339ef53f84d055b66b565c7ef60770",
  approvalMessage:
    "Veylo payee approval v1\nOrg: 11111111-1111-4111-8111-111111111111\nContractor: Ada Lovelace (22222222-2222-4222-8222-222222222222)\nPay to: 0xAf780910c0E7D41430D4615A437676a87a332C8C\nRoute: USDC on Base\nRecipient type: DESTINATION_CHAIN\nVersion: 1\nExpires: 2027-05-05T10:00:00.000Z\nRecord: sha256:e043a6e73e11a11edc0f5e2180f46f1e13339ef53f84d055b66b565c7ef60770",
  setHash: "c05e01cdfdcf213ccf7e1cf49185630b6c8d6d6167fd5573cc29473b1e799905",
  headMessage:
    "Veylo payee registry v1\nOrg: 11111111-1111-4111-8111-111111111111\nVersion: 3\nActive payees: 2\nSet: sha256:c05e01cdfdcf213ccf7e1cf49185630b6c8d6d6167fd5573cc29473b1e799905\nSigned: 2026-11-06T10:00:00.000Z",
  emptySetHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

const head = () => ({
  orgId: RECORD.orgId,
  version: 3,
  recordHashes: [SECOND_HASH, payeeRecordHash(RECORD)],
  signedAt: APPROVED_AT,
});

const signedApproval = () => ({
  record: RECORD,
  contractorName: NAME,
  routeLabel: LABEL,
  nonce: NONCE_A,
  recipient: RECIPIENT,
  publicKey: PUBLIC_KEY,
  signature: sign(GOLDEN.approvalMessage, NONCE_A),
});
const signedHead = () => ({
  ...head(),
  nonce: NONCE_B,
  recipient: RECIPIENT,
  publicKey: PUBLIC_KEY,
  signature: sign(GOLDEN.headMessage, NONCE_B),
});

describe("golden vectors: these bytes are signed, and must never change", () => {
  it("canonical record", () => {
    expect(canonicalPayeeRecord(RECORD)).toBe(GOLDEN.canonical);
  });

  it("record hash", () => {
    expect(payeeRecordHash(RECORD)).toBe(GOLDEN.recordHash);
    expect(createHash("sha256").update(GOLDEN.canonical).digest("hex")).toBe(GOLDEN.recordHash);
  });

  it("approval message", () => {
    expect(buildApprovalMessage({ record: RECORD, contractorName: NAME, routeLabel: LABEL })).toBe(
      GOLDEN.approvalMessage,
    );
  });

  it("set hash, the same in any input order, cross-checked with Node's SHA-256", () => {
    const { recordHashes } = head();
    expect(payeeSetHash(recordHashes)).toBe(GOLDEN.setHash);
    expect(payeeSetHash([...recordHashes].reverse())).toBe(GOLDEN.setHash);
    const lines = [...recordHashes].sort().join("\n");
    expect(createHash("sha256").update(lines).digest("hex")).toBe(GOLDEN.setHash);
  });

  it("an empty set hashes the empty string", () => {
    expect(payeeSetHash([])).toBe(GOLDEN.emptySetHash);
    expect(createHash("sha256").update("").digest("hex")).toBe(GOLDEN.emptySetHash);
  });

  it("head message", () => {
    expect(buildHeadMessage(head())).toBe(GOLDEN.headMessage);
  });
});

describe("independent verification", () => {
  it("accepts a good approval and a good head", () => {
    expect(verifyPayeeApproval(signedApproval())).toBe(true);
    expect(verifyRegistryHead(signedHead())).toBe(true);
  });
});

describe("tampering with each record field fails", () => {
  const LATER = new Date("2030-01-01T00:00:00.000Z");
  it.each<[string, Partial<PayeeRecord>]>([
    ["orgId", { orgId: "x" }],
    ["contractorId", { contractorId: "x" }],
    ["destinationId", { destinationId: "x" }],
    ["routeId", { routeId: "usdc-arbitrum" }],
    ["recipient", { recipient: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }],
    ["recipientType", { recipientType: "CONFIDENTIAL_INTENTS" }],
    ["version", { version: 2 }],
    ["approvedAt", { approvedAt: LATER }],
    ["expiresAt", { expiresAt: LATER }],
  ])("%s", (_name, change) => {
    const record = { ...RECORD, ...change };
    expect(payeeRecordHash(record)).not.toBe(GOLDEN.recordHash);
    expect(verifyPayeeApproval({ ...signedApproval(), record })).toBe(false);
  });

  it("the name and route label shown to the signer are covered too", () => {
    expect(verifyPayeeApproval({ ...signedApproval(), contractorName: "Mallory" })).toBe(false);
    expect(verifyPayeeApproval({ ...signedApproval(), routeLabel: "USDC on Solana" })).toBe(false);
  });
});

describe("tampering with each message line fails", () => {
  const edited = (message: string, i: number) => {
    const lines = message.split("\n");
    lines[i] = `${lines[i]}x`;
    return lines.join("\n");
  };

  it.each(GOLDEN.approvalMessage.split("\n").map((l, i) => [l.split(":")[0], i] as const))(
    "approval line %s",
    (_label, i) => {
      const { nonce, recipient, publicKey, signature } = signedApproval();
      expect(
        verifyNep413({ message: GOLDEN.approvalMessage, nonce, recipient, publicKey, signature }),
      ).toBe(true);
      expect(
        verifyNep413({
          message: edited(GOLDEN.approvalMessage, i),
          nonce,
          recipient,
          publicKey,
          signature,
        }),
      ).toBe(false);
    },
  );

  it.each(GOLDEN.headMessage.split("\n").map((l, i) => [l.split(":")[0], i] as const))(
    "head line %s",
    (_label, i) => {
      const { nonce, recipient, publicKey, signature } = signedHead();
      expect(
        verifyNep413({ message: GOLDEN.headMessage, nonce, recipient, publicKey, signature }),
      ).toBe(true);
      expect(
        verifyNep413({
          message: edited(GOLDEN.headMessage, i),
          nonce,
          recipient,
          publicKey,
          signature,
        }),
      ).toBe(false);
    },
  );
});

describe("head tampering", () => {
  it.each<[string, object]>([
    ["org", { orgId: "x" }],
    ["version", { version: 4 }],
    ["a dropped payee", { recordHashes: [SECOND_HASH] }],
    ["an added payee", { recordHashes: [SECOND_HASH, GOLDEN.recordHash, "c".repeat(64)] }],
    ["signed time", { signedAt: new Date("2030-01-01T00:00:00.000Z") }],
  ])("%s", (_name, change) => {
    expect(verifyRegistryHead({ ...signedHead(), ...change })).toBe(false);
  });
});

describe("no message of one kind verifies as another", () => {
  const SIGN_IN = [
    "Sign in to Veylo",
    `Account: ${RECORD.orgId}`,
    `Nonce: ${"01".repeat(32)}`,
    "Issued: 2026-11-06T10:00:00.000Z",
    "Expires: 2026-11-06T10:05:00.000Z",
  ].join("\n");

  it("each first line is different", () => {
    const firsts = [GOLDEN.approvalMessage, GOLDEN.headMessage, SIGN_IN].map(
      (m) => m.split("\n")[0],
    );
    expect(new Set(firsts).size).toBe(3);
  });

  it("a head or sign-in signature fails as an approval", () => {
    for (const message of [GOLDEN.headMessage, SIGN_IN]) {
      expect(verifyPayeeApproval({ ...signedApproval(), signature: sign(message, NONCE_A) })).toBe(
        false,
      );
    }
  });

  it("an approval or sign-in signature fails as a head", () => {
    for (const message of [GOLDEN.approvalMessage, SIGN_IN]) {
      expect(verifyRegistryHead({ ...signedHead(), signature: sign(message, NONCE_B) })).toBe(
        false,
      );
    }
  });

  it("an approval or head signature fails as a sign-in", () => {
    for (const message of [GOLDEN.approvalMessage, GOLDEN.headMessage]) {
      expect(
        verifyNep413({
          message: SIGN_IN,
          nonce: NONCE_A,
          recipient: RECIPIENT,
          publicKey: PUBLIC_KEY,
          signature: sign(message, NONCE_A),
        }),
      ).toBe(false);
    }
  });
});

describe("the set is the canonical form the hash covers", () => {
  it("sorted, one per line", () => {
    expect(canonicalPayeeSet([SECOND_HASH, "a".repeat(64)])).toBe(
      `${"a".repeat(64)}\n${SECOND_HASH}`,
    );
  });
});
