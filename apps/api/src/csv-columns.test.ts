// The CSV's transaction link (slice W3, bookkeeper README): private payouts say "confidential",
// direct payouts link their explorer transaction.
import { describe, expect, it } from "vitest";
import { transactionLink } from "./reporting-routes.js";

describe("CSV transaction link", () => {
  it('is "confidential" for a private payout, even if a NEAR tx exists', () => {
    expect(
      transactionLink({
        route: "usdc-near-confidential",
        links: { destinationTx: null, nearTxs: ["https://nearblocks.io/txns/abc"] },
      }),
    ).toBe("confidential");
  });
  it("is the destination explorer link for a direct payout", () => {
    expect(
      transactionLink({
        route: "usdc-near",
        links: {
          destinationTx: "https://nearblocks.io/txns/dst",
          nearTxs: ["https://nearblocks.io/txns/abc"],
        },
      }),
    ).toBe("https://nearblocks.io/txns/dst");
  });
  it("falls back to the first NEAR transaction, then to empty", () => {
    expect(
      transactionLink({
        route: "usdc-near",
        links: { destinationTx: null, nearTxs: ["https://nearblocks.io/txns/abc"] },
      }),
    ).toBe("https://nearblocks.io/txns/abc");
    expect(transactionLink({ route: null, links: { destinationTx: null, nearTxs: [] } })).toBe("");
  });
});
