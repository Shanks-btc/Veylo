import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CONFIDENTIAL_NOTE, payoutProof, ProofCell } from "./payout-proof";

const html = (p: ReturnType<typeof payoutProof>) =>
  renderToStaticMarkup(createElement(ProofCell, { proof: p }));

describe("pay run status: transaction column", () => {
  it("a direct payout links to its NEAR explorer transaction", () => {
    const p = payoutProof("direct", {
      destinationTx: "https://nearblocks.io/txns/abc",
      nearTxs: [],
    });
    expect(p).toEqual({ kind: "link", href: "https://nearblocks.io/txns/abc" });
    const out = html(p);
    expect(out).toContain('href="https://nearblocks.io/txns/abc"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("View on NEAR explorer");
  });

  it('a private payout shows "Confidential" with its one-line explanation, never a link', () => {
    const p = payoutProof("private", {
      destinationTx: null,
      nearTxs: ["https://nearblocks.io/txns/abc"],
    });
    expect(p).toEqual({ kind: "confidential" });
    const out = html(p);
    expect(out).toContain("Confidential");
    expect(out).toContain(CONFIDENTIAL_NOTE.replace("'", "&#x27;"));
    expect(out).not.toContain("href=");
  });

  it("never links a URL that isn't a known NEAR explorer", () => {
    expect(
      payoutProof("direct", { destinationTx: "https://evil.example/tx", nearTxs: [] }),
    ).toEqual({ kind: "none" });
    expect(payoutProof("direct", { destinationTx: "javascript:alert(1)", nearTxs: [] })).toEqual({
      kind: "none",
    });
    expect(payoutProof("direct", undefined)).toEqual({ kind: "none" });
  });
});
