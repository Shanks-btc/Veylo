// Claims stay factual (slice W5): no user-facing copy calls Veylo the first, the only or unique.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findClaims, findNotOffered } from "./claims.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const web = join(root, "apps", "web");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const rel = (p: string) => relative(root, p).split("\\").join("/");

// User-facing copy: the landing page, app screens and shell, shared UI, page meta and the reference page.
const COPY = ["src/landing", "src/screens", "src/app-ui", "src/app", "src/ui", "src/site.ts"];
const copyFiles = files(join(web, "src"))
  .filter((f) => /\.(tsx?)$/.test(f) && !/\.test\.tsx?$/.test(f))
  .filter((f) => COPY.some((d) => rel(f).startsWith(`apps/web/${d}`)));
const docs = ["README.md", "PRIVACY.md", "SECURITY.md", "design/reference/landing.html"];

// The guard skips lines that begin with "*" because in code they are comments. In a document a line
// that begins with "**" is a bold paragraph, so the leading asterisks come off before it looks.
const asMarkdown = (text: string) => text.replace(/^(\s*)\*+/gm, "$1");

describe("what counts as a claim", () => {
  it.each([
    "Veylo is the first private payroll on NEAR.",
    "The only payroll tool that hides salaries.",
    "A unique way to pay people.",
    "First-ever confidential payroll.",
    "The world's first payroll app for NEAR.",
    "One of a kind.",
  ])("flags: %s", (text) => {
    expect(findClaims(text)).toHaveLength(1);
  });

  it.each([
    "A first payout to an address needs you to tick a box.",
    "Contractors can only read their own payslips.",
    "Only your treasury wallet signs.",
  ])("allows: %s", (text) => {
    expect(findClaims(text)).toEqual([]);
  });
});

describe("user-facing copy", () => {
  it("finds the copy files it is meant to guard", () => {
    expect(copyFiles.length).toBeGreaterThan(20);
  });

  it("no screen, landing section or page meta says first, only or unique", () => {
    const hits = copyFiles.flatMap((f) =>
      findClaims(readFileSync(f, "utf8")).map((h) => `${rel(f)} ${h}`),
    );
    expect(hits).toEqual([]);
  });

  it("no document a reader sees first says first, only or unique", () => {
    const hits = docs.flatMap((d) =>
      findClaims(asMarkdown(readFileSync(join(root, d), "utf8"))).map((h) => `${d} ${h}`),
    );
    expect(hits).toEqual([]);
  });
});

describe("what Veylo does not offer (slice W7.1)", () => {
  it.each([
    "Earn 5% APY on your treasury.",
    "Your balance earns yield.",
    "A Visa card for contractors.",
    "Spend with a debit card.",
    "Cash out through the off-ramp.",
    "Treasury interest, paid monthly.",
  ])("flags: %s", (text) => {
    expect(findNotOffered(text)).toHaveLength(1);
  });

  it.each([
    "Bank wires take days and charge fees on both ends; many contractors wait weeks.",
    "Contractors see payslips and their private balance in their own portal.",
    "// a comment may say yield or interest",
  ])("allows: %s", (text) => {
    expect(findNotOffered(text)).toEqual([]);
  });

  it("no screen, landing section or page meta uses those words", () => {
    const hits = copyFiles.flatMap((f) =>
      findNotOffered(readFileSync(f, "utf8")).map((h) => `${rel(f)} ${h}`),
    );
    expect(hits).toEqual([]);
  });

  it("no document a reader sees first uses those words", () => {
    const hits = docs.flatMap((d) =>
      findNotOffered(asMarkdown(readFileSync(join(root, d), "utf8"))).map((h) => `${d} ${h}`),
    );
    expect(hits).toEqual([]);
  });
});

// The README rewrite: the real README text goes through the same guards, and putting each banned
// word or claim into it makes the guard fail, so a later edit can't bring one in unnoticed.
describe("the README is guarded", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const withLine = (line: string) => asMarkdown(`${readme}\n\n${line}\n`);

  it("is clean as written", () => {
    expect(findClaims(asMarkdown(readme))).toEqual([]);
    expect(findNotOffered(asMarkdown(readme))).toEqual([]);
  });

  it.each([
    "Veylo is the first private payroll on NEAR.",
    "The only way to pay a team privately.",
    "A unique approach to payroll.",
    "**Veylo is the first payroll app for NEAR.**",
  ])("fails when the README claims: %s", (line) => {
    expect(findClaims(withLine(line))).toHaveLength(1);
  });

  it.each([
    ["APY", "Earn 5% APY on your treasury."],
    ["yield", "Your balance earns yield."],
    ["interest", "Treasury interest, paid monthly."],
    ["Visa", "A Visa card for contractors."],
    ["debit card", "Spend with a debit card."],
    ["off-ramp", "Cash out through the off-ramp."],
    ["bare APY", "APY"],
    ["bare yield", "yield"],
    ["bare interest", "interest"],
    ["bare Visa", "Visa"],
    ["bare debit card", "debit card"],
    ["bare off-ramp", "off-ramp"],
    ["bold-led yield", "**Yield** on your balance."],
  ])("fails when the README uses %s", (_name, line) => {
    expect(findNotOffered(withLine(line))).toHaveLength(1);
  });

  it("still allows a first payout, and a plain 'only you' about who signs", () => {
    expect(
      findClaims(withLine("A first payout to a new address needs you to tick a box.")),
    ).toEqual([]);
    expect(findClaims(withLine("Only you can move money."))).toEqual([]);
  });
});
