// Claims stay factual (slice W5): no user-facing copy calls Veylo the first, the only or unique.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findClaims } from "./claims.js";

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
      findClaims(readFileSync(join(root, d), "utf8")).map((h) => `${d} ${h}`),
    );
    expect(hits).toEqual([]);
  });
});
