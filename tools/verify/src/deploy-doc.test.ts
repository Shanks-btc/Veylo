// docs/DEPLOY.md must have a row for every environment variable each process loads, in that
// process's own table, and must never carry a value for a secret (slices 6.1, 6.2).
import { CONFIG_NAMES } from "@veylo/config";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const doc = readFileSync(join(root, "docs", "DEPLOY.md"), "utf8");

/** The section 3 table under each heading, up to the next heading. */
const HEADINGS: Record<keyof typeof CONFIG_NAMES, string> = {
  api: "### `api`",
  "worker:settlement": "### `worker:settlement`",
  migrate: "### Pre-deploy: `migrate`",
  "worker:agents": "### `worker:agents`",
};
function table(process: keyof typeof CONFIG_NAMES) {
  const start = doc.indexOf(HEADINGS[process]);
  if (start < 0) return "";
  const rest = doc.slice(start + HEADINGS[process].length);
  const end = rest.search(/\n#{2,3} /);
  return end < 0 ? rest : rest.slice(0, end);
}
const rows = Object.entries(CONFIG_NAMES).flatMap(([process, names]) =>
  names.map((name) => [process as keyof typeof CONFIG_NAMES, name] as const),
);

describe("docs/DEPLOY.md", () => {
  it("has a table for each process", () => {
    for (const process of Object.keys(HEADINGS) as (keyof typeof CONFIG_NAMES)[])
      expect(table(process), process).toContain("| Name");
  });

  it.each(rows)("%s table has a row for %s", (process, name) => {
    const row = table(process)
      .split("\n")
      .find((l) => l.startsWith(`| \`${name}\` `));
    expect(row, `no row for ${name} under ${HEADINGS[process]}`).toBeDefined();
  });

  it("a process's table lists nothing that process doesn't load", () => {
    for (const [process, names] of Object.entries(CONFIG_NAMES)) {
      const listed = [
        ...table(process as keyof typeof CONFIG_NAMES).matchAll(/^\| `([A-Z_]+)` /gm),
      ].map((m) => m[1]);
      expect(listed.sort(), process).toEqual([...names].sort());
    }
  });

  it("covers the required topics", () => {
    for (const s of [
      "pnpm db:migrate",
      "/health",
      "/ready",
      "TRUST_PROXY_HOPS",
      "LOG_CLIENT_IP=true",
      "LOG_CLIENT_IP=false",
      "refusing to start",
      "L26",
      "L23",
      // The agents worker is never deployed (L46), and the wallet bridge has its own origin (L44).
      "out of scope (L46",
      "Wallet bridge",
    ])
      expect(doc).toContain(s);
  });

  it("holds no secret value", () => {
    expect(doc).not.toMatch(/postgres(ql)?:\/\/[^<\s`]*:[^@\s`]+@/);
    expect(doc).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(doc).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(doc).not.toMatch(/[A-Za-z0-9+/]{43}=/);
  });
});

describe("docs/DEPLOY.md, slice W5", () => {
  const section = (title: string) => {
    const start = doc.indexOf(title);
    if (start < 0) return "";
    const rest = doc.slice(start + title.length);
    const end = rest.search(/\n## /);
    return end < 0 ? rest : rest.slice(0, end);
  };
  const web = (file: string) => readFileSync(join(root, "apps", "web", file), "utf8");

  it("keeps the hosted demo up until at least 2026-11-25 (Q-012)", () => {
    const s = section("## 14. Hosted demo");
    expect(s).toContain("2026-11-25");
    expect(s).toContain("Q-012");
    expect(s).toContain("2026-11-18");
  });

  it("has the pre-deploy checklist, and says nothing deploys itself", () => {
    const s = section("## 14. Hosted demo");
    for (const needed of [
      "Before the first deploy",
      "pnpm verify",
      "pnpm demo",
      "pnpm test:pg",
      "LICENSES.md",
    ])
      expect(s, needed).toContain(needed);
    expect(s).toContain("Nothing here deploys itself");
  });

  it("explains the local wallet test: Postgres, migrate, dev:wallet, localhost:3000, Meteor", () => {
    const s = section("## 13. Real-wallet test");
    for (const needed of [
      "Postgres",
      "pnpm db:migrate",
      "pnpm dev:wallet",
      "http://localhost:3000",
      "Meteor",
    ])
      expect(s, needed).toContain(needed);
  });

  it("lists every NEXT_PUBLIC_ and BRIDGE_ variable the web and bridge builds read", () => {
    const sources = [
      "src/config.ts",
      "src/site.ts",
      "src/app-ui/session.tsx",
      "src/demo/load.ts",
      "scripts/build-bridge.mjs",
      "scripts/csp.mjs",
      "scripts/bridge-csp.mjs",
    ].map(web);
    const names = new Set(
      sources.flatMap((t) =>
        [...t.matchAll(/\b(?:NEXT_PUBLIC|BRIDGE)_[A-Z_]+\b/g)].map((m) => m[0]),
      ),
    );
    // BRIDGE_PROTOCOL is a protocol constant in the code, not a setting.
    names.delete("BRIDGE_PROTOCOL");
    expect(names.size).toBeGreaterThan(8);
    const s = section("## 14. Hosted demo");
    const missing = [...names].filter((n) => !s.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });

  it("never sets the demo flag on the real app", () => {
    expect(section("## 14. Hosted demo")).toContain("Leave it unset on the real app");
  });
});

describe("docs/DEPLOY.md, the 1Click partner key (W6)", () => {
  const start = doc.indexOf("## 15. The 1Click partner key");
  const section = start < 0 ? "" : doc.slice(start);

  it("names the one variable, where to get the key and the official docs", () => {
    expect(section).toContain("`ONECLICK_PARTNER_KEY`");
    expect(section).toContain("https://partners.near-intents.org/home");
    expect(section).toContain(
      "https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md",
    );
    expect(section).toContain("X-API-Key");
  });

  it("says which features need it and that verify skips without it", () => {
    expect(section).toContain("Which features need it");
    expect(section).toContain("SKIPPED");
    expect(section).toContain("`worker:settlement`");
  });

  it("holds no key value", () => {
    expect(section).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});

describe("docs/DEPLOY.md, wallets, email and exchange rates (W6)", () => {
  const between = (from: string, to: string) => {
    const a = doc.indexOf(from);
    const b = doc.indexOf(to, a + 1);
    return a < 0 ? "" : doc.slice(a, b < 0 ? undefined : b);
  };

  it("section 12 describes one page per wallet, the Veylo wallet page, and the pinned executors", () => {
    const s = between("## 12. Wallet bridge", "## 13. ");
    for (const must of [
      "w/<wallet id>/index.html",
      "embedded/index.html",
      "connect-src 'none'",
      "publickey-credentials",
      "SHA-256",
      "WALLETS.md",
      "pnpm wallets:refresh",
    ])
      expect(s, must).toContain(must);
    expect(s).toContain("frame-ancestors");
  });

  it("section 16 says plainly that no email is sent yet, and what the founder must decide", () => {
    const s = between("## 16. Email delivery", "## 17. ");
    expect(s).toContain("email_outbox");
    expect(s).toMatch(/nothing sends it yet/i);
    for (const must of ["provider", "SPF, DKIM and DMARC", "delivered_at", "Retention"])
      expect(s, must).toContain(must);
  });

  it("section 17 names the one exchange-rate source, says it needs no key and that it is display only", () => {
    const s = between("## 17. Exchange rates", "\n## 18. ");
    expect(s).toContain("https://open.er-api.com/v6/latest/USD");
    expect(s).toMatch(/No key and no variable/);
    expect(s).toMatch(/Never in a payment/);
  });

  it("lists sections 16 and 17 in the contents", () => {
    expect(doc).toContain("16. Email delivery (not built yet)");
    expect(doc).toContain("17. Exchange rates for local-currency estimates");
  });
});
