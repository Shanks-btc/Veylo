// Currency claims stay honest (slice W6, part 3c): Veylo pays NEAR accounts in USDC (or NEAR). Local
// currencies are display-only estimates. No user-facing copy may say or imply that Veylo pays a bank
// account, pays out fiat, or converts to cash. The one allowed mention is the roadmap line, worded
// exactly as the founder set it. A sentence that says what Veylo does NOT do is fine.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const web = join(root, "apps", "web");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const rel = (p: string) => relative(root, p).split("\\").join("/");

/** Words that claim money reaches a bank or becomes fiat. */
const BANK_CLAIM =
  /\b(bank (transfers?|payouts?|deposits?|accounts?|withdrawals?|cash-?out)|(pay|paid|paying|send|sends|sending|deposit|deposits|withdraw|withdraws|cash(es)? out)\b[^.\n]{0,40}\b(to|into|in)\b[^.\n]{0,20}\b(a |your |their |the )?bank|fiat( payouts?| off-?ramps?| withdrawals?| cash-?out)?|IBAN|SWIFT|\bACH\b|mobile money|m-?pesa|wire transfer|local-?currency payouts?)\b/i;
/** A sentence that says what Veylo does not do, or that it is planned, is not a claim. */
const NOT_A_CLAIM =
  /\b(not|n't|cannot|can't|never|no bank|without|planned|roadmap|after the hackathon|coming|estimates?|display)\b|\?/i;

export function bankClaims(text: string): string[] {
  let heading = "";
  const hits: string[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (/^#{1,6}\s/.test(line)) heading = line;
    if (!BANK_CLAIM.test(line)) continue;
    if (/roadmap|after the hackathon/i.test(heading)) continue;
    if (NOT_A_CLAIM.test(line)) continue;
    hits.push(`line ${i + 1}: ${line.trim().slice(0, 90)}`);
  }
  return hits;
}

const COPY_DIRS = ["src/landing", "src/screens", "src/app-ui", "src/app", "src/ui", "src/site.ts"];
const copyFiles = files(join(web, "src"))
  .filter((f) => /\.(tsx?)$/.test(f) && !/\.test\.tsx?$/.test(f))
  .filter((f) => COPY_DIRS.some((d) => rel(f).startsWith(`apps/web/${d}`)));
const docs = [
  "README.md",
  "PRIVACY.md",
  "SECURITY.md",
  "docs/DEPLOY.md",
  "docs/WALLETS.md",
  "docs/ECOSYSTEM.md",
];

/** The roadmap line, exactly. */
export const ROADMAP_LINE =
  "Bank cash-out in local currency through licensed partners (after the hackathon)";

describe("what counts as a bank or fiat claim", () => {
  it.each([
    "Veylo pays your contractors' bank accounts.",
    "Send salaries to a bank in Nigeria.",
    "Fiat payouts in naira.",
    "Withdraw to your bank in one click.",
    "Instant bank transfers for every contractor.",
    "Cash out to M-Pesa.",
  ])("flags: %s", (text) => {
    expect(bankClaims(text)).toHaveLength(1);
  });

  it.each([
    "Veylo does not pay bank accounts.",
    "Amounts shown in a local currency are estimates for reading only.",
    "Bank cash-out in local currency through licensed partners (after the hackathon).",
    "Not today: payouts go to NEAR accounts in USDC.",
  ])("allows: %s", (text) => {
    expect(bankClaims(text)).toEqual([]);
  });
});

describe("user-facing copy", () => {
  it("finds the copy it is meant to guard", () => {
    expect(copyFiles.length).toBeGreaterThan(30);
  });

  it("no screen, page or landing section claims bank payouts or fiat", () => {
    const hits = copyFiles.flatMap((f) =>
      bankClaims(readFileSync(f, "utf8")).map((h) => `${rel(f)} ${h}`),
    );
    expect(hits).toEqual([]);
  });

  it("no document a reader sees first claims bank payouts or fiat", () => {
    const hits = docs.flatMap((d) => {
      try {
        return bankClaims(readFileSync(join(root, d), "utf8")).map((h) => `${d} ${h}`);
      } catch {
        return []; // A document that doesn't exist yet has nothing to claim.
      }
    });
    expect(hits).toEqual([]);
  });

  it("says the roadmap line, exactly, where a reader looks for it", () => {
    for (const f of [
      "README.md",
      "apps/web/src/screens/public-docs.tsx",
      "apps/web/src/screens/portal-balance.tsx",
    ]) {
      expect(readFileSync(join(root, f), "utf8"), f).toContain(ROADMAP_LINE);
    }
  });
});
