import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  canonicalPayeeRecord,
  canonicalPayeeSet,
  payeeApprovalMessage,
  registryHeadMessage,
  type PayeeRecord,
} from "@veylo/core";
import { verifyNep413 } from "./nep413.js";

export const sha256Text = (text: string): string =>
  bytesToHex(sha256(new TextEncoder().encode(text)));

export const payeeRecordHash = (record: PayeeRecord): string =>
  sha256Text(canonicalPayeeRecord(record));

export const payeeSetHash = (recordHashes: readonly string[]): string =>
  sha256Text(canonicalPayeeSet(recordHashes));

export function buildApprovalMessage(input: {
  record: PayeeRecord;
  contractorName: string;
  routeLabel: string;
}): string {
  return payeeApprovalMessage({ ...input, recordHashHex: payeeRecordHash(input.record) });
}

export function buildHeadMessage(input: {
  orgId: string;
  version: number;
  recordHashes: readonly string[];
  signedAt: Date;
}): string {
  return registryHeadMessage({
    orgId: input.orgId,
    version: input.version,
    count: input.recordHashes.length,
    setHashHex: payeeSetHash(input.recordHashes),
    signedAt: input.signedAt,
  });
}

type SignedBy = {
  nonce: Uint8Array;
  recipient: string;
  publicKey: string;
  signature: string;
};

/**
 * Independent checks, from the record rather than a served message: what the browser's gate B runs.
 * A signature over any other message, including the other kind or sign-in, fails.
 */
export function verifyPayeeApproval(
  input: SignedBy & { record: PayeeRecord; contractorName: string; routeLabel: string },
): boolean {
  return verifyNep413({ ...input, message: buildApprovalMessage(input) });
}

export function verifyRegistryHead(
  input: SignedBy & {
    orgId: string;
    version: number;
    recordHashes: readonly string[];
    signedAt: Date;
  },
): boolean {
  return verifyNep413({ ...input, message: buildHeadMessage(input) });
}
