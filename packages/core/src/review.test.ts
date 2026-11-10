import { describe, expect, it } from "vitest";
import { hasBlockingFlag, reviewFlags } from "./review.js";

const base = {
  contractorStatus: "active",
  destination: { id: "d1", enteredBy: "contractor" as const, contractorConfirmedAt: new Date(0) },
  payable: { payable: true, payableReason: "ok" as const },
  lastPaid: { destinationId: "d1", amount: 1000n },
  amount: 1000n,
  deviationPercent: 25,
  feePreviewFailed: false,
};
const codes = (change: object) =>
  reviewFlags({ ...base, ...change }).map((f) => `${f.code}${f.blocking ? "!" : ""}`);

describe("reviewFlags", () => {
  it("a clean item has no flags", () => {
    expect(codes({})).toEqual([]);
  });

  it.each<[string, object, string[]]>([
    [
      "not payable, with the reason",
      { payable: { payable: false, payableReason: "approval_expired" } },
      ["destination_not_payable!"],
    ],
    [
      "no destination at all",
      { destination: null, payable: { payable: false, payableReason: "no_active_destination" } },
      ["destination_not_payable!"],
    ],
    [
      "superseded awaiting a new head",
      { payable: { payable: false, payableReason: "superseded_awaiting_new_head" } },
      ["superseded_awaiting_new_head!"],
    ],
    [
      "archived, flagged once",
      {
        contractorStatus: "archived",
        payable: { payable: false, payableReason: "contractor_archived" },
      },
      ["contractor_archived!"],
    ],
    ["fee preview failed", { feePreviewFailed: true }, ["fee_preview_unavailable!"]],
    [
      "owner-entered and unconfirmed",
      { destination: { id: "d1", enteredBy: "owner", contractorConfirmedAt: null } },
      ["not_contractor_confirmed"],
    ],
    [
      "owner-entered but confirmed is fine",
      { destination: { id: "d1", enteredBy: "owner", contractorConfirmedAt: new Date(0) } },
      [],
    ],
    ["first payment", { lastPaid: undefined }, ["first_payment"]],
    [
      "new destination since the last paid run",
      { destination: { ...base.destination, id: "d2" } },
      ["new_destination_since_last_paid"],
    ],
    ["26% up", { amount: 1260n }, ["amount_deviation"]],
    ["26% down", { amount: 740n }, ["amount_deviation"]],
    ["exactly 25% is fine", { amount: 1250n }, []],
    ["a configurable threshold", { amount: 1110n, deviationPercent: 10 }, ["amount_deviation"]],
  ])("%s", (_name, change, expected) => {
    expect(codes(change)).toEqual(expected);
  });

  it("detail names the payable reason and the last amount", () => {
    const flags = reviewFlags({
      ...base,
      amount: 2000n,
      payable: { payable: false, payableReason: "approval_revoked" },
    });
    expect(flags.map((f) => f.detail)).toEqual(["approval_revoked", "1000 last time"]);
  });

  it("only the agreed flags block", () => {
    expect(hasBlockingFlag(reviewFlags({ ...base, lastPaid: undefined, amount: 9n }))).toBe(false);
    expect(hasBlockingFlag(reviewFlags({ ...base, contractorStatus: "archived" }))).toBe(true);
  });
});
