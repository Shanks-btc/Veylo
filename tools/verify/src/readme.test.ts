// The README is the first thing a bookkeeper or a screener reads (slice W5, A2). These tests keep it
// honest: every command it tells someone to run exists, the Judge quickstart is at the top, every
// required section is present, and no sentence claims to be the first, the only or unique.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findClaims } from "./claims.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const scripts = (
  JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

// pnpm commands that are not package.json scripts.
const PNPM_BUILTINS = new Set(["i", "install", "add", "exec", "dlx"]);

/** Every `pnpm <word>` written in the README, with the word after it. */
function pnpmCommands(text: string): string[] {
  return [...text.matchAll(/\bpnpm\s+([a-z][a-z0-9:_-]*)/g)].map((m) => m[1] ?? "");
}

describe("README commands", () => {
  it("mentions the commands a reader needs", () => {
    const used = new Set(pnpmCommands(readme));
    for (const needed of ["i", "demo", "dev:web", "dev:wallet", "verify", "install"])
      expect(used.has(needed), `README never mentions pnpm ${needed}`).toBe(true);
  });

  it("every pnpm command in the README exists in package.json (or is a pnpm built-in)", () => {
    const missing = [...new Set(pnpmCommands(readme))].filter(
      (c) => !PNPM_BUILTINS.has(c) && !(c in scripts),
    );
    expect(missing).toEqual([]);
  });

  it("the commands behind Try it are real scripts that point at real files", () => {
    for (const name of ["demo", "dev:web", "dev:wallet"]) {
      const target = scripts[name]?.match(/node\s+(\S+)/)?.[1];
      expect(target, `${name} runs node`).toBeTruthy();
      expect(() => readFileSync(resolve(root, target ?? ""), "utf8")).not.toThrow();
    }
  });
});

describe("README structure", () => {
  const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1] ?? "");

  it("opens with private payroll, then the evidence condition", () => {
    const firstLine = readme.split("\n").find((l) => l.startsWith("**")) ?? "";
    expect(firstLine).toMatch(/^\*\*Private payroll on NEAR/);
    expect(firstLine).toContain("NEAR Confidential Intents");
    expect(readme).toContain(
      "Private means no public source we checked links a confidential payout to the company, provided the payout address has never received a public payment from it.",
    );
  });

  it("puts the Judge quickstart before every other section", () => {
    expect(headings[0]).toBe("Judge quickstart");
  });

  it("the quickstart has six Do -> See rows, a placeholder URL and the one-line demo", () => {
    const section = readme.split(/^## /m).find((s) => s.startsWith("Judge quickstart")) ?? "";
    const rows = section.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l));
    expect(rows).toHaveLength(6);
    expect(section).toContain("<hosted-demo-url>");
    expect(section).toContain("pnpm i && pnpm demo");
  });

  it("has every required section", () => {
    const required = [
      /^Judge quickstart$/,
      /^Try it$/,
      /^Built on NEAR$/,
      /^Why there's no relayer$/,
      /^Email accounts and wallets$/,
      /^Currencies$/,
      /^How Veylo compares$/,
      /^Built with$/,
      /^Proven on mainnet$/,
      /^Hackathon$/,
      /^Roadmap after the hackathon$/,
    ];
    for (const r of required)
      expect(
        headings.some((h) => r.test(h)),
        `README is missing a section matching ${r}`,
      ).toBe(true);
  });

  it("cites the sources its claims rest on", () => {
    expect(readme).toContain("https://docs.near.org/web3-apps/tutorials/meta-transactions");
    expect(readme).toContain("https://docs.business.near.com/");
    expect(readme).toContain(
      "https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution",
    );
    expect(readme).toContain("docs/EVIDENCE.md");
  });

  it("does not name other hackathon teams", () => {
    expect(readme).not.toMatch(/\bteam [A-Z][a-z]+\b.*hackathon/i);
  });

  it("makes no first, only or unique claim", () => {
    expect(findClaims(readme)).toEqual([]);
  });
});
