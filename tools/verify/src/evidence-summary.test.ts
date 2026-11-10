import { describe, expect, it } from "vitest";
import { summarizeEvidence } from "./evidence-summary.mjs";

const row = (status: string, i = 0) => ({
  chain: "near",
  tx: `tx${i}`,
  event: "e",
  status,
  detail: "d",
});

describe("summarizeEvidence", () => {
  it("all PASS: one PASS line, no row lines", () => {
    const s = summarizeEvidence([row("PASS", 1), row("PASS", 2)]);
    expect(s.summary).toMatchObject({ status: "PASS", detail: "2 of 2" });
    expect(s.rows).toEqual([]);
  });

  it("any FAIL fails the summary and is listed", () => {
    const s = summarizeEvidence([row("PASS", 1), row("FAIL", 2), row("SKIPPED", 3)]);
    expect(s.summary).toMatchObject({ status: "FAIL", detail: "1 of 3 contradicted by the chain" });
    expect(s.rows.map((r: { status: string }) => r.status)).toEqual(["FAIL", "SKIPPED"]);
  });

  it("a skipped row is never summarized as PASS", () => {
    const s = summarizeEvidence([row("PASS", 1), row("SKIPPED", 2)]);
    expect(s.summary).toMatchObject({
      status: "SKIPPED",
      detail: "1 of 2 passed, 1 skipped (network)",
    });
    expect(s.rows).toHaveLength(1);
  });

  it("everything skipped is network unavailable", () => {
    expect(summarizeEvidence([row("SKIPPED"), row("SKIPPED")]).summary).toMatchObject({
      status: "SKIPPED",
      detail: "network unavailable",
    });
  });

  it("no rows fails", () => {
    expect(summarizeEvidence([]).summary.status).toBe("FAIL");
  });

  it("the report lists every row", () => {
    const s = summarizeEvidence([row("PASS", 1), row("FAIL", 2)]);
    expect(s.report).toContain("| PASS | near | `tx1` |");
    expect(s.report).toContain("| FAIL | near | `tx2` |");
  });
});
