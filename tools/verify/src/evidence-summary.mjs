// Turns per-row evidence results into verify's lines: one summary, plus a line for each row that
// isn't PASS, and the full table for verify-report.md. Never PASS unless every row passed.

/**
 * @param {{ chain: string, tx: string, event: string, status: string, detail: string }[]} results
 */
export function summarizeEvidence(results) {
  const name = "evidence re-check against public RPC (§11.5)";
  const n = results.length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;
  /** @type {{ status: "PASS" | "FAIL" | "SKIPPED", name: string, detail: string }} */
  let summary;
  if (n === 0) summary = { status: "FAIL", name, detail: "docs/EVIDENCE.md has no rows" };
  else if (failed > 0) {
    summary = { status: "FAIL", name, detail: `${failed} of ${n} contradicted by the chain` };
  } else if (passed === n) summary = { status: "PASS", name, detail: `${passed} of ${n}` };
  else if (skipped === n) summary = { status: "SKIPPED", name, detail: "network unavailable" };
  else {
    summary = {
      status: "SKIPPED",
      name,
      detail: `${passed} of ${n} passed, ${skipped} skipped (network)`,
    };
  }
  const short = (/** @type {string} */ tx) => (tx.length > 14 ? `${tx.slice(0, 10)}…` : tx);
  const rows = results
    .filter((r) => r.status !== "PASS")
    .map((r) => ({
      status: /** @type {"FAIL" | "SKIPPED"} */ (r.status),
      name: `  evidence ${r.chain} ${short(r.tx)}`,
      detail: `${r.detail}: ${r.event}`,
    }));
  const report = [
    "# verify report: evidence re-check",
    "",
    `Summary: ${summary.status}, ${summary.detail}.`,
    "",
    "| Status | Chain | Transaction | Event | Detail |",
    "|---|---|---|---|---|",
    ...results.map((r) => `| ${r.status} | ${r.chain} | \`${r.tx}\` | ${r.event} | ${r.detail} |`),
    "",
  ].join("\n");
  return { summary, rows, report };
}
