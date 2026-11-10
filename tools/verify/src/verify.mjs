// `pnpm verify`: typechecks every package, runs every test, and prints a pass/fail report.
// Exits non-zero on any failure. A check that isn't built yet is reported as SKIPPED, never as passed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeEvidence } from "./evidence-summary.mjs";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * Runs with the same Node that runs this script, so a wrong version can't pass by accident.
 * @param {string[]} args
 */
function run(args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    seconds: Math.round((Date.now() - started) / 1000),
    output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? String(result.error) : ""}`,
  };
}

function workspaces() {
  return ["apps", "packages", "tools"].flatMap((group) => {
    const dir = join(root, group);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => existsSync(join(path, "tsconfig.json")));
  });
}

/** @type {{ status: "PASS" | "FAIL" | "SKIPPED", name: string, detail: string }[]} */
const results = [];
/** @type {{ name: string, output: string }[]} */
const failures = [];

const nodePinned = process.versions.node.startsWith("24.");
results.push({
  status: nodePinned ? "PASS" : "FAIL",
  name: "Node version is 24 (.nvmrc)",
  detail: process.version,
});
if (!nodePinned)
  failures.push({ name: "Node version", output: "Use the Node 24 version in .nvmrc." });

for (const dir of workspaces()) {
  const name = relative(root, dir).replaceAll("\\", "/");
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const check = run([tsc, "--noEmit", "-p", join(dir, "tsconfig.json")]);
  results.push({
    status: check.ok ? "PASS" : "FAIL",
    name: `typecheck ${name}`,
    detail: `${check.seconds}s`,
  });
  if (!check.ok) failures.push({ name: `typecheck ${name}`, output: check.output });
}

const typecheckOnly = process.argv.includes("--typecheck-only");
if (typecheckOnly) {
  for (const r of results) console.log(`  ${r.status.padEnd(7)}  ${r.name}  ${r.detail}`);
  for (const failure of failures)
    console.log(`
--- ${failure.name} ---
${failure.output.trim()}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

const reportDir = mkdtempSync(join(tmpdir(), "veylo-verify-"));
const reportFile = join(reportDir, "tests.json");
const vitest = join(root, "node_modules", "vitest", "vitest.mjs");
const tests = run([vitest, "run", "--reporter=json", `--outputFile=${reportFile}`]);
let summary = "no test report was produced";
let testsOk = tests.ok;
/** Checks that ARCHITECTURE §11 lists, each proven by a named test file. Missing or empty fails. */
const suites = [
  {
    name: "tenant-isolation tests (§11.2)",
    file: "apps/api/src/tenant-isolation.test.ts",
    total: 0,
    failed: 0,
  },
  {
    name: "address-validation tests (§11.1)",
    file: "packages/chains/src/addresses.test.ts",
    total: 0,
    failed: 0,
  },
];
if (existsSync(reportFile)) {
  /**
   * @type {{
   *   numTotalTests: number, numPassedTests: number, numFailedTests: number,
   *   testResults: {
   *     name: string, status: string, message?: string,
   *     assertionResults: { status: string, fullName: string, failureMessages?: string[] }[],
   *   }[],
   * }}
   */
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  summary = `${report.numPassedTests} of ${report.numTotalTests} passed in ${report.testResults.length} files, ${tests.seconds}s`;
  for (const file of report.testResults) {
    const path = file.name.replaceAll("\\", "/");
    for (const suite of suites) {
      if (!path.endsWith(suite.file)) continue;
      suite.total = file.assertionResults.length;
      suite.failed = file.assertionResults.filter((t) => t.status !== "passed").length;
    }
  }
  // A run that found no tests must not count as success.
  if (report.numTotalTests === 0 || report.numFailedTests > 0) testsOk = false;
  const failed = report.testResults.flatMap((file) =>
    file.assertionResults
      .filter((t) => t.status === "failed")
      .map(
        (t) =>
          `${relative(root, file.name)}: ${t.fullName}\n${(t.failureMessages ?? []).join("\n")}`,
      ),
  );
  const fileErrors = report.testResults
    .filter((file) => file.status === "failed" && file.assertionResults.length === 0)
    .map((file) => `${relative(root, file.name)}: ${file.message}`);
  if (!testsOk)
    failures.push({
      name: "tests",
      output: [...failed, ...fileErrors].join("\n\n") || tests.output,
    });
} else {
  testsOk = false;
  failures.push({ name: "tests", output: tests.output });
}
rmSync(reportDir, { recursive: true, force: true });
results.push({
  status: testsOk ? "PASS" : "FAIL",
  name: "unit, database and guard tests",
  detail: summary,
});

for (const suite of suites) {
  const ok = suite.total > 0 && suite.failed === 0;
  results.push({
    status: ok ? "PASS" : "FAIL",
    name: suite.name,
    detail: ok
      ? `${suite.total} of ${suite.total} passed`
      : `${suite.failed} failed of ${suite.total} in ${suite.file}`,
  });
  if (!ok)
    failures.push({
      name: suite.name,
      output: `${suite.file} must exist, contain tests and pass.`,
    });
}

// §11.3 spends nothing, but needs a partner key. Without one it's SKIPPED, never PASS.
if (process.env.ONECLICK_PARTNER_KEY?.trim()) {
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const quotes = run([tsx, join(root, "tools", "verify", "src", "dry-quotes.ts")]);
  /** @type {{ route: string, outcome: string, detail: string }[]} */
  let rows = [];
  try {
    rows = JSON.parse(quotes.output.trim().split("\n").at(-1) ?? "[]");
  } catch {
    rows = [];
  }
  if (rows.length === 0) {
    results.push({
      status: "FAIL",
      name: "dry 1Click quotes on the supported routes (§11.3)",
      detail: "the check produced no results",
    });
    failures.push({
      name: "dry quotes",
      output: "tools/verify/src/dry-quotes.ts produced no results.",
    });
  }
  for (const row of rows) {
    const ok = row.outcome === "accepted";
    results.push({
      status: ok ? "PASS" : "FAIL",
      name: `dry 1Click quote ${row.route} (§11.3)`,
      detail: row.detail,
    });
    if (!ok)
      failures.push({ name: `dry quote ${row.route}`, output: `${row.outcome}: ${row.detail}` });
  }
} else {
  results.push({
    status: "SKIPPED",
    name: "dry 1Click quotes on the supported routes (§11.3)",
    detail: "no partner key (ONECLICK_PARTNER_KEY)",
  });
}

// Production runs built JS only (L24, L37): the build must succeed and emit every entry point.
{
  const build = run([join(root, "apps", "api", "build.mjs")]);
  results.push({
    status: build.ok ? "PASS" : "FAIL",
    name: "production build (apps/api/dist)",
    detail: build.ok ? `${build.seconds}s` : "build failed",
  });
  if (!build.ok) failures.push({ name: "production build", output: build.output });
}

// §11.5: every docs/EVIDENCE.md row against public RPC, no keys. Offline is SKIPPED, never PASS.
{
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const check = run([tsx, join(root, "tools", "verify", "src", "evidence-check.ts")]);
  /** @type {{ error?: string, results?: { chain: string, tx: string, event: string, status: string, detail: string }[] }} */
  let out = {};
  try {
    out = JSON.parse(check.output.trim().split("\n").at(-1) ?? "{}");
  } catch {
    out = { error: "the evidence check produced no readable output" };
  }
  const label = "evidence re-check against public RPC (§11.5)";
  if (out.error || !out.results) {
    results.push({ status: "FAIL", name: label, detail: out.error ?? "no results" });
    failures.push({ name: "evidence re-check", output: out.error ?? check.output });
  } else if (out.results.length === 0) {
    results.push({ status: "FAIL", name: label, detail: "docs/EVIDENCE.md has no rows" });
    failures.push({ name: "evidence re-check", output: "docs/EVIDENCE.md has no rows." });
  } else {
    // One summary line; a line for each FAIL or SKIPPED row only; every row in verify-report.md.
    const s = summarizeEvidence(out.results);
    results.push(s.summary, ...s.rows);
    writeFileSync(join(root, "verify-report.md"), s.report);
    for (const r of out.results.filter((x) => x.status === "FAIL"))
      failures.push({ name: `evidence ${r.tx}`, output: `${r.detail}: ${r.event}` });
  }
}

/** @type {[string, string][]} */
const notImplemented = [
  ["attestation fetch and cryptographic verification (§11.4)", "slice 7"],
  ["agent spending-policy tests (§11.1)", "slice 8"],
  ["privacy check on confidential payouts (§11.6)", "slice 10"],
];
for (const [name, slice] of notImplemented) {
  results.push({ status: "SKIPPED", name, detail: `not implemented yet (${slice})` });
}

const width = Math.max(...results.map((r) => r.name.length));
console.log(`\nveylo verify (Node ${process.version})\n`);
for (const r of results)
  console.log(`  ${r.status.padEnd(7)}  ${r.name.padEnd(width)}  ${r.detail}`);

for (const failure of failures) {
  console.log(`\n--- ${failure.name} ---\n${failure.output.trim()}`);
}

/** @param {string} status */
const count = (status) => results.filter((r) => r.status === status).length;
const passed = count("FAIL") === 0;
console.log(
  `\n${passed ? "PASS" : "FAIL"}: ${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIPPED")} skipped\n`,
);
process.exit(passed ? 0 : 1);
