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
      "slice 8",
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
