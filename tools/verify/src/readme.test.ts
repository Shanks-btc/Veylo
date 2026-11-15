// The README is what a judge, a screener and a bookkeeper read first (slices W5, W6 and the README
// rewrite). These tests keep it honest: the landing-page image exists and sits right under the title,
// the quickstart stays at the top, every section and table is there, every command and file it names
// is real, the evidence condition travels with the privacy claim, and the status table matches
// docs/EVIDENCE.md. A separate guard (claims.test.ts) keeps out first, only, unique and the words for
// things Veylo does not offer.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findClaims, findNotOffered } from "./claims.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const readme = read("README.md");
const readJson = <T>(path: string) => JSON.parse(read(path)) as T;
const scripts = readJson<{ scripts: Record<string, string> }>("package.json").scripts;
const webScripts = readJson<{ scripts: Record<string, string> }>("apps/web/package.json").scripts;
const apiScripts = readJson<{ scripts: Record<string, string> }>("apps/api/package.json").scripts;

const EVIDENCE_CONDITION =
  "Private means no public source we checked links a confidential payout to the company, provided the payout address has never received a public payment from it.";

// pnpm commands that are not package.json scripts.
const PNPM_BUILTINS = new Set(["i", "install", "add", "exec", "dlx"]);
const WORKSPACE_SCRIPTS: Record<string, Record<string, string>> = {
  "@veylo/web": webScripts,
  "@veylo/api": apiScripts,
};

/** Every `pnpm <word>` written in the README, with the word after it. */
function pnpmCommands(text: string): string[] {
  return [...text.matchAll(/\bpnpm\s+([a-z][a-z0-9:_-]*)/g)].map((m) => m[1] ?? "");
}

/** Every `pnpm --filter <package> <script>` written in the README. */
function filteredCommands(text: string): { pkg: string; script: string }[] {
  return [...text.matchAll(/\bpnpm\s+--filter\s+(\S+)\s+([a-z][a-z0-9:_-]*)/g)].map((m) => ({
    pkg: m[1] ?? "",
    script: m[2] ?? "",
  }));
}

/** The README's sections, by heading. The first chunk (title, image, intro) has no heading. */
const chunks = readme.split(/^## /m);
const intro = chunks[0] ?? "";
const sections = new Map(
  chunks.slice(1).map((chunk) => {
    const newline = chunk.indexOf("\n");
    return [chunk.slice(0, newline).trim(), chunk.slice(newline + 1)] as const;
  }),
);
const headings = [...sections.keys()];
const section = (name: string) => sections.get(name) ?? "";

/** The first Markdown table in `text`: its header cells, then the cells of each row. */
function firstTable(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trimStart().startsWith("|"));
  if (start < 0) return { header: [], rows: [] };
  const block: string[] = [];
  for (let i = start; i < lines.length && (lines[i] ?? "").trimStart().startsWith("|"); i++)
    block.push(lines[i] ?? "");
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const [head, , ...body] = block;
  return { header: cells(head ?? ""), rows: body.map(cells) };
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .trim()
    .replace(/ /g, "-");

// The guard skips lines that begin with "*" because in code they are comments. In Markdown a line
// that begins with "**" is a bold paragraph, so the leading asterisks come off before it looks.
const asMarkdown = (text: string) => text.replace(/^(\s*)\*+/gm, "$1");

/** The `code` tokens in a table cell. */
const codeTokens = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

/** Paths named in a "Location" or "Where" cell. A bare file name sits next to the path before it. */
function pathsIn(cell: string): string[] {
  let dir = "";
  const found: string[] = [];
  for (const token of codeTokens(cell)) {
    if (token.includes("*")) continue;
    if (token.includes("/")) {
      found.push(token);
      dir = /\.[a-z]+$/.test(token) ? dirname(token).split("\\").join("/") : token;
    } else if (/\.[a-z]+$/.test(token) && dir) found.push(`${dir}/${token}`);
  }
  return found;
}

describe("README commands", () => {
  it("mentions the commands a reader needs", () => {
    const used = new Set(pnpmCommands(readme));
    for (const needed of ["i", "demo", "dev:web", "dev:wallet", "verify", "install", "build"])
      expect(used.has(needed), `README never mentions pnpm ${needed}`).toBe(true);
  });

  it("every pnpm command in the README exists in package.json (or is a pnpm built-in)", () => {
    const missing = [...new Set(pnpmCommands(readme))].filter(
      (c) => !PNPM_BUILTINS.has(c) && !(c in scripts),
    );
    expect(missing).toEqual([]);
  });

  it("every `pnpm --filter <package> <script>` names a real workspace script", () => {
    const commands = filteredCommands(readme);
    expect(commands.length).toBeGreaterThan(0);
    for (const { pkg, script } of commands) {
      const known = WORKSPACE_SCRIPTS[pkg];
      expect(known, `README filters on an unknown package ${pkg}`).toBeTruthy();
      expect(script in (known ?? {}), `${pkg} has no script ${script}`).toBe(true);
    }
  });

  it("every `check:*` script the README names exists in the web package", () => {
    const named = [...readme.matchAll(/`(check:[a-z:]+)`/g)].map((m) => m[1] ?? "");
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(name in webScripts, `no web script ${name}`).toBe(true);
  });

  it("the commands behind Try it are real scripts that point at real files", () => {
    for (const name of ["demo", "dev:web", "dev:wallet"]) {
      const target = scripts[name]?.match(/node\s+(\S+)/)?.[1];
      expect(target, `${name} runs node`).toBeTruthy();
      expect(() => readFileSync(resolve(root, target ?? ""), "utf8")).not.toThrow();
    }
  });
});

describe("README top", () => {
  it("starts with the title, then the landing page image, centred, directly under it", () => {
    const lines = readme.split("\n");
    expect(lines[0]).toBe("# Veylo");
    const next = lines.slice(1).find((l) => l.trim() !== "") ?? "";
    expect(next).toMatch(
      /^<p align="center"><img src="[^"]+" alt="Veylo landing page" width="100%"><\/p>$/,
    );
  });

  it("the image is a relative path to a file in design/images that exists", () => {
    const src = readme.match(/<img src="([^"]+)"/)?.[1] ?? "";
    expect(src).not.toMatch(/^[a-z]+:|^\//);
    const path = decodeURIComponent(src);
    expect(path).toMatch(/^design\/images\/veylo-landing[^/]*\.(png|jpe?g|webp)$/);
    expect(existsSync(resolve(root, path)), `${path} does not exist`).toBe(true);
  });

  it("the image sits above the first section", () => {
    expect(readme.indexOf("<img ")).toBeGreaterThan(-1);
    expect(readme.indexOf("<img ")).toBeLessThan(readme.search(/^## /m));
  });

  it("opens with one paragraph on private, borderless payroll, then the evidence condition", () => {
    expect(intro).toContain("**Veylo is private, borderless payroll on NEAR.**");
    expect(intro).toContain("USDC");
    expect(intro).toContain("gasless");
    expect(intro).toContain(EVIDENCE_CONDITION);
    expect(intro.indexOf("<img ")).toBeLessThan(intro.indexOf("**Veylo is private"));
    expect(intro.indexOf("**Veylo is private")).toBeLessThan(intro.indexOf(EVIDENCE_CONDITION));
  });

  it("links the live app, the repository and the demo video under the intro", () => {
    const line = intro.split("\n").find((l) => l.startsWith("**Live app:**")) ?? "";
    expect(line).toContain("](https://veylopay.vercel.app)");
    expect(line).toContain("](https://github.com/Shanks-btc/Veylo)");
    expect(line).toContain("**Demo video:**");
    expect(readme).not.toContain("<hosted-demo-url>");
    expect(readme).not.toMatch(/[a-z0-9-]+-[a-z0-9]{8,}-[a-z0-9-]+\.vercel\.app/);
  });
});

// The sections, in order. The diagrams add no section and the Contents list stays as it is.
const ORDER = [
  "Try it in 2 minutes",
  "Contents",
  "The problem",
  "What Veylo does",
  "How it works",
  "Architecture",
  "Core components",
  "The pay run, step by step",
  "What Veylo's server does, and what it never does",
  "What NEAR provides",
  "Wallets",
  "Current status",
  "Safety and tests",
  "Quick start",
  "Environment variables",
  "Repository layout",
  "Roadmap",
  "Built at NEAR HACKATHON",
  "License",
];

describe("README structure", () => {
  it("has every section, in this order", () => {
    expect(headings).toEqual(ORDER);
  });

  it("puts the quickstart first and near the top of the file", () => {
    expect(headings[0]).toBe("Try it in 2 minutes");
    const at = readme.split("\n").findIndex((l) => l.startsWith("## Try it in 2 minutes"));
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(16);
  });

  it("the quickstart has six Do -> See rows, the live app URL and the one-line local demo", () => {
    const quickstart = section("Try it in 2 minutes");
    const rows = quickstart.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l));
    expect(rows).toHaveLength(6);
    expect(firstTable(quickstart).header).toEqual(["#", "Do", "See"]);
    expect(quickstart).toContain("**Live app:** https://veylopay.vercel.app");
    expect(quickstart).toContain("pnpm i && pnpm demo");
  });

  it("the Contents list links every later section, and every link lands on a heading", () => {
    const links = [...section("Contents").matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] ?? "");
    const anchors = new Set(headings.map(slug));
    for (const link of links) expect(anchors.has(link), `no heading for #${link}`).toBe(true);
    expect(links).toEqual(ORDER.filter((h) => h !== "Contents").map(slug));
  });

  it("has no placeholder text left in it", () => {
    expect(readme).not.toMatch(/\b(TODO|TBD|FIXME|lorem ipsum)\b|VERIFY_TESTS|<placeholder>/i);
  });
});

describe("README privacy claim", () => {
  it("repeats the evidence condition verbatim where it explains what private means", () => {
    expect(section("What Veylo does")).toContain(EVIDENCE_CONDITION);
    expect(readme.split(EVIDENCE_CONDITION).length - 1).toBeGreaterThanOrEqual(2);
  });

  it("says private isn't anonymous", () => {
    expect(section("What Veylo does")).toContain("Private isn't anonymous");
  });
});

describe("README tables", () => {
  it("What Veylo does: the six principles", () => {
    const { header, rows } = firstTable(section("What Veylo does"));
    expect(header).toEqual(["Principle", "What it means"]);
    expect(rows.map((r) => (r[0] ?? "").replace(/\*\*/g, ""))).toEqual([
      "Private by default",
      "Only you can move money",
      "Your browser checks every payout",
      "Gasless for everyone",
      "Any NEAR wallet or an embedded wallet",
      "Nothing hidden",
    ]);
  });

  it("Architecture: every layer, and every path it names exists", () => {
    const { header, rows } = firstTable(section("Architecture"));
    expect(header).toEqual(["Layer", "Responsibility", "Location"]);
    const layers = rows.map((r) => r[0] ?? "");
    for (const layer of [
      "Web app",
      "Wallet bridge origin",
      "Embedded wallet",
      "Browser gates",
      "API",
      "Cron routes",
      "Database",
      "NEAR Intents / 1Click client",
      "Verify and proof pages",
    ])
      expect(layers, `no layer ${layer}`).toContain(layer);
    for (const row of rows)
      for (const path of pathsIn(row[2] ?? ""))
        expect(existsSync(resolve(root, path)), `${path} does not exist`).toBe(true);
  });

  it("Core components: gates A, B, B2, C and F, the registry, wallet, scheduler, importer, portal, verify page", () => {
    const { header, rows } = firstTable(section("Core components"));
    expect(header).toEqual(["Component", "What it does", "Where"]);
    const names = rows.map((r) => r[0] ?? "");
    for (const part of [
      "Gate A",
      "Gate B,",
      "Gate B2",
      "Gate C",
      "Gate F",
      "Payee registry",
      "Embedded wallet",
      "Scheduler",
      "CSV importer",
      "Contractor portal",
      "Verify page",
    ])
      expect(
        names.some((n) => n.startsWith(part)),
        `no component ${part}`,
      ).toBe(true);
    for (const row of rows)
      for (const path of pathsIn(row[2] ?? ""))
        expect(existsSync(resolve(root, path)), `${path} does not exist`).toBe(true);
  });

  it("The pay run: eight numbered steps, and the 1Click calls it names are the ones the client makes", () => {
    const { header, rows } = firstTable(section("The pay run, step by step"));
    expect(header).toEqual(["Step", "Name", "What happens", "Who signs / which NEAR call"]);
    expect(rows.map((r) => r[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(rows.map((r) => r[1])).toEqual([
      "Draft",
      "Review",
      "Quote",
      "Check",
      "Approve",
      "Submit",
      "Settle",
      "Record",
    ]);
    const client = read("packages/intents/src/oneclick-treasury.ts");
    const named = [...section("The pay run, step by step").matchAll(/`(\/v0\/[a-z-]+)`/g)].map(
      (m) => m[1] ?? "",
    );
    expect(named.length).toBeGreaterThan(0);
    for (const call of named) expect(client, `the client never calls ${call}`).toContain(call);
    expect(rows[4]?.[3]).toContain("NEP-413");
  });

  it("The server table has two columns, does and never does", () => {
    const { header, rows } = firstTable(
      section("What Veylo's server does, and what it never does"),
    );
    expect(header).toEqual(["Veylo's server does", "Veylo's server never does"]);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const never = rows.map((r) => r[1] ?? "").join(" ");
    for (const phrase of ["private key", "Sign anything", "Move funds", "Log signed payloads"])
      expect(never, `the "never" column omits: ${phrase}`).toContain(phrase);
  });

  it("What NEAR provides: each piece, and no mandatory integration (Q-011)", () => {
    const body = section("What NEAR provides");
    const { header, rows } = firstTable(body);
    expect(header).toEqual(["NEAR piece", "What Veylo uses it for"]);
    const pieces = rows.map((r) => r[0] ?? "").join(" | ");
    for (const piece of [
      "intents.near",
      "intents.far",
      "1Click",
      "Confidential Intents",
      "NEP-413",
      "near-connect",
      "Implicit accounts",
      "NEP-141",
    ])
      expect(pieces, `missing ${piece}`).toContain(piece);
    expect(body).toContain("**Mandatory integrations: none.**");
    expect(body).toContain("(Q-011)");
    expect(body).toContain("https://docs.near.org/web3-apps/tutorials/meta-transactions");
    expect(body).toContain(
      "https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution",
    );
  });

  it("Wallets: names every enabled wallet in docs/WALLETS.md, with the same count, and links it", () => {
    const body = section("Wallets");
    const doc = read("docs/WALLETS.md");
    const enabled = doc.split("## Enabled wallets")[1]?.split("\n## ")[0] ?? "";
    const names = [...enabled.matchAll(/^\| ([^|(]+?) \(`/gm)].map((m) => m[1] ?? "");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(body, `README omits ${name}`).toContain(name);
    expect(body).toContain(`Veylo enables ${names.length} NEAR wallets`);
    expect(body).toContain("(docs/WALLETS.md)");
    expect(body).toContain("Meteor only");
  });

  it("Current status: Surface, Status, Detail, with honest statuses and the evidence row", () => {
    const { header, rows } = firstTable(section("Current status"));
    expect(header).toEqual(["Surface", "Status", "Detail"]);
    const allowed = new Set(["Live", "Fixture-tested", "Coming soon", "See the file"]);
    for (const row of rows) expect(allowed.has(row[1] ?? ""), `status "${row[1]}"`).toBe(true);
    for (const status of ["Live", "Fixture-tested", "Coming soon"])
      expect(
        rows.some((r) => r[1] === status),
        `no ${status} row`,
      ).toBe(true);
    const coming = rows
      .filter((r) => r[1] === "Coming soon")
      .map((r) => `${r[0]} ${r[2]}`)
      .join(" ");
    for (const item of ["NEAR", "USDT on NEAR", "Cash-out", "Email delivery"])
      expect(coming, `"Coming soon" omits ${item}`).toContain(item);
    const evidence = rows.find((r) => r[0] === "Mainnet evidence");
    expect(evidence?.[2]).toContain("(docs/EVIDENCE.md)");
  });

  it("Environment variables: Name, Required, Service, Description; every name is real; no values", () => {
    const { header, rows } = firstTable(section("Environment variables"));
    expect(header).toEqual(["Name", "Required", "Service", "Description"]);
    const example = read(".env.example");
    const config = read("packages/config/src/index.ts");
    for (const row of rows) {
      const name = codeTokens(row[0] ?? "")[0] ?? "";
      expect(name, "a row without a name").not.toBe("");
      if (name.includes("*")) {
        expect(example).toContain(name.replace("*", "NEAR"));
        continue;
      }
      expect(
        example.includes(`${name}=`) || config.includes(name),
        `${name} is in neither .env.example nor the config`,
      ).toBe(true);
    }
    for (const required of [
      "DATABASE_URL",
      "SESSION_ENCRYPTION_KEY",
      "ONECLICK_PARTNER_KEY",
      "CRON_SECRET",
    ])
      expect(
        rows.some((r) => (r[0] ?? "").includes(required)),
        `no row for ${required}`,
      ).toBe(true);
  });

  it("Repository layout: every directory in the tree exists", () => {
    const block = section("Repository layout").match(/```\n([\s\S]*?)```/)?.[1] ?? "";
    const stack: string[] = [];
    let checked = 0;
    for (const line of block.split("\n")) {
      const m = line.match(/^(\s*)([\w./-]+)(?:\s{2,}\S.*)?$/);
      if (!m) continue;
      const depth = (m[1] ?? "").length / 2;
      stack.length = depth;
      stack[depth] = (m[2] ?? "").replace(/\/$/, "");
      const path = stack.join("/");
      expect(existsSync(resolve(root, path)), `${path} does not exist`).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(12);
  });
});

describe("README links and sources", () => {
  it("every relative link points at a file or folder that exists", () => {
    const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1] ?? "")
      .filter((t) => !/^(https?:|#|mailto:)/.test(t))
      .map((t) => decodeURIComponent(t.split("#")[0] ?? ""));
    expect(targets.length).toBeGreaterThan(10);
    for (const target of targets)
      expect(existsSync(resolve(root, target)), `${target} does not exist`).toBe(true);
  });

  it("cites the sources its claims rest on", () => {
    expect(readme).toContain("https://docs.business.near.com/");
    expect(readme).toContain("docs/EVIDENCE.md");
    expect(readme).toContain("docs/FUNDING.md");
    expect(readme).toContain("docs/WALLETS.md");
  });

  it("every spike it names is a spike in VERIFICATION.md", () => {
    const verification = read("VERIFICATION.md");
    const spikes = new Set([...readme.matchAll(/\bS-[A-Z][A-Z0-9]*\b/g)].map((m) => m[0]));
    expect(spikes.size).toBeGreaterThan(3);
    for (const spike of spikes)
      expect(verification, `VERIFICATION.md has no ${spike}`).toMatch(
        new RegExp(`^### ${spike} `, "m"),
      );
  });

  it("the licence it names is the one in LICENSE", () => {
    expect(section("License")).toContain("MIT");
    expect(read("LICENSE")).toMatch(/^MIT License/);
  });

  it("does not name other hackathon teams", () => {
    expect(readme).not.toMatch(/\bteam [A-Z][a-z]+\b.*hackathon/i);
  });
});

describe("README evidence", () => {
  it("says what docs/EVIDENCE.md says about product payouts, and nothing more", () => {
    const evidence = read("docs/EVIDENCE.md");
    const product = evidence.split("## Section 1: Product payouts")[1]?.split("\n## ")[0] ?? "";
    const none = /^None yet\.$/m.test(product);
    const row = firstTable(section("Current status")).rows.find((r) => r[0] === "Mainnet evidence");
    if (none) {
      expect(row?.[2]).toContain('product payouts "None yet"');
      expect(section("Current status")).toContain('says "None yet."');
    } else {
      expect(section("Current status")).not.toContain("None yet");
    }
  });

  it("counts the same re-checked transactions that docs/EVIDENCE.md lists", () => {
    const rows = read("docs/EVIDENCE.md")
      .split("\n")
      .filter((l) => /^\| \d+ \|/.test(l)).length;
    expect(section("Current status")).toContain(`${rows} transactions from test scripts`);
    expect(section("Safety and tests")).toContain(`${rows} of ${rows} passed`);
  });
});

describe("README claims", () => {
  it("looks at bold paragraphs too", () => {
    expect(findClaims(asMarkdown("**Veylo is the first private payroll on NEAR.**"))).toHaveLength(
      1,
    );
    expect(findNotOffered(asMarkdown("**Earn yield on your treasury.**"))).toHaveLength(1);
  });

  it("makes no first, only or unique claim", () => {
    expect(findClaims(asMarkdown(readme))).toEqual([]);
  });

  it("uses none of the words for things Veylo does not offer", () => {
    expect(findNotOffered(asMarkdown(readme))).toEqual([]);
  });

  it("holds no secret-looking value, and no VARIABLE=value line", () => {
    expect(readme).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/);
    expect(readme).not.toMatch(/\beyJ[A-Za-z0-9_-]{10,}/);
    expect(readme).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/);
    expect(readme).not.toMatch(/^[A-Z][A-Z0-9_]{3,}=\S+/m);
  });
});

// ---------------------------------------------------------------------------------------------
// Diagrams (README diagrams). GitHub draws a ```mermaid fence natively. Each diagram has a short bold
// title above it and a one-line italic caption below it. These tests keep them in the right places,
// plain, in the Veylo palette, true to the code, and inside the same claims guard as the prose.
// That each diagram also parses is checked with the Mermaid CLI (see the report), because the
// repository doesn't depend on Mermaid.
// ---------------------------------------------------------------------------------------------

type Diagram = {
  section: string;
  /** The bold line above the fence, as written. */
  title: string;
  code: string;
  /** The italic line below the fence, as written. */
  caption: string;
  /** Bold title, blank line, fence, blank line, one caption line, blank line (or the end). */
  shaped: boolean;
};

/** The Mermaid diagrams in one section, each with the title above it and the caption below it. */
function diagramsIn(sectionName: string, body: string): Diagram[] {
  const lines = body.split("\n");
  const found: Diagram[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() !== "```mermaid") continue;
    let end = i + 1;
    while (end < lines.length && (lines[end] ?? "").trim() !== "```") end += 1;
    const title = (lines[i - 2] ?? "").trim();
    const caption = (lines[end + 2] ?? "").trim();
    found.push({
      section: sectionName,
      title,
      code: lines.slice(i + 1, end).join("\n"),
      caption,
      shaped:
        (lines[i - 1] ?? "x").trim() === "" &&
        /^\*\*[^*]+\*\*$/.test(title) &&
        (lines[end + 1] ?? "x").trim() === "" &&
        /^_[^_]+_$/.test(caption) &&
        (lines[end + 3] === undefined || (lines[end + 3] ?? "").trim() === ""),
    });
    i = end;
  }
  return found;
}

const diagrams = [...sections].flatMap(([name, body]) => diagramsIn(name, body));
const DIAGRAM_START = /^(?:flowchart (?:TB|TD|BT|RL|LR)|sequenceDiagram)$/;
const firstCodeLine = (code: string) =>
  code
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("%%")) ?? "";

/** The words a reader sees in a diagram: quoted labels, and in a sequence diagram the message, note, participant and block text. */
function labelsOf(code: string): string[] {
  const sequence = firstCodeLine(code) === "sequenceDiagram";
  const labels: string[] = [];
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (/^(?:classDef|class)\s/.test(line)) continue;
    labels.push(...[...line.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? ""));
    if (!sequence) continue;
    const text =
      line.match(/\sas\s+(.+)$/)?.[1] ??
      line.match(/^(?:alt|else|loop|opt)\s+(.+)$/)?.[1] ??
      line.match(/:\s*(.+)$/)?.[1];
    if (text) labels.push(text);
  }
  return labels;
}

/** The nodes a flowchart defines (an id followed by a quoted label). */
function nodeIds(code: string): string[] {
  const body = code
    .split("\n")
    .filter((l) => !/^\s*(?:subgraph|classDef|class|direction)\b/.test(l))
    .join("\n");
  const ids = [...body.matchAll(/(?:^|[\s>|])([A-Za-z][A-Za-z0-9_]*)(?:\[\(|\[|\{)\s*"/gm)];
  return [...new Set(ids.map((m) => m[1] ?? ""))];
}

const classDefs = (code: string) =>
  [...code.matchAll(/^\s*classDef\s+(\w+)\s+(.+)$/gm)].map((m) => ({
    name: m[1] ?? "",
    style: m[2] ?? "",
  }));
const classUses = (code: string) =>
  [...code.matchAll(/^\s*class\s+(\S+)\s+(\w+)\s*$/gm)].map((m) => ({
    ids: (m[1] ?? "").split(","),
    name: m[2] ?? "",
  }));

/** In which order the texts first appear in the code. */
function inOrder(code: string, texts: string[]) {
  const at = texts.map((t) => code.indexOf(t));
  expect(
    at.every((p) => p >= 0),
    `missing from the diagram: ${texts.filter((t, i) => (at[i] ?? -1) < 0).join(", ")}`,
  ).toBe(true);
  expect(at, `out of order: ${texts.join(" | ")}`).toEqual([...at].sort((a, b) => a - b));
}

const PRIVATE_AND_DIRECT = "Private and direct payouts";

const WANTED: {
  title: string;
  section: string;
  start: string;
  needs: string[];
  order?: string[];
}[] = [
  {
    title: "System architecture",
    section: "How it works",
    start: "flowchart TB",
    needs: [
      '"Browser"',
      '"Wallet bridge origin"',
      '"Veylo API"',
      '"Cron routes"',
      '"NEAR"',
      "Web app",
      "Gates A, B, B2, C and F",
      "Check results",
      "Embedded wallet: the key stays here",
      "Pinned wallet executors",
      "Accounts, payee records, pay runs, quotes, ledger",
      "Holds no private key",
      "Neon Postgres",
      "settlement",
      "prepare-drafts",
      "intents.near",
      "intents.far",
      "NEAR RPC",
      "1Click API",
      "signed payee list",
      "quote request",
      "signed intent",
      "status poll",
    ],
  },
  {
    title: "A month in Veylo",
    section: "How it works",
    start: "flowchart LR",
    needs: [],
    order: [
      "Sign up",
      "Get a wallet",
      "Fund in USDC on NEAR",
      "Add team",
      "Sign payee list",
      "Review pay run",
      "Approve in wallet",
      "Settle",
      "Payslips and verify",
    ],
  },
  {
    title: "Funding the treasury",
    section: "How it works",
    start: "flowchart TB",
    needs: [
      "USDC on NEAR",
      "Convert from another network",
      "NEAR, or USDT on NEAR: coming soon",
      "Gate F",
      "Deposit address and QR code shown",
      "You send the funds",
      "Waiting for your deposit",
      "Done: the funds are in your treasury",
    ],
  },
  {
    title: "The pay run as a sequence",
    section: "The pay run, step by step",
    start: "sequenceDiagram",
    needs: [
      "alt A gate fails",
      "Approve stays locked",
      "Nothing is signed or submitted. The flow stops here.",
      "else Gates A, B, B2, C and time left all pass",
      "signMessage (NEP-413)",
      "/v0/quote",
      "/v0/generate-intent",
      "/v0/submit-intent",
      "/v0/status",
      "loop Until the payout is final",
      "1 Draft",
      "2 Review",
      "3 Quote",
      "4 Check",
      "5 Approve",
      "6 Submit",
      "7 Settle",
      "8 Record",
    ],
    order: [
      "participant Owner",
      "participant Browser",
      "participant Wallet",
      "participant API as Veylo API",
      "participant OC as 1Click",
      "participant NI as NEAR Intents",
    ],
  },
  {
    title: "How the gates decide",
    section: "Core components",
    start: "flowchart TB",
    needs: [
      "Quote and intent message",
      "Approve unlocks",
      "Approve stays locked, with the reason in plain words",
      "Gate F",
      "Funding quote",
      "1 USDC and 1%",
      "not rolled back",
    ],
    order: ["Gate A:", "Time left:", "Gate B:", "Gate B2:", "Gate C:"],
  },
  {
    title: PRIVATE_AND_DIRECT,
    section: "What Veylo does",
    start: "flowchart TB",
    needs: [
      "Direct payout",
      "Private payout",
      "NEAR Intents, public balance: intents.near",
      "Confidential balance: intents.far",
      "Anyone can follow it from treasury to recipient",
      "No public transaction names the treasury",
    ],
  },
  {
    title: "The trust boundary",
    section: "What Veylo's server does, and what it never does",
    start: "flowchart LR",
    needs: [
      "You: keys and approvals",
      "Wallet: holds the key and signs",
      "Browser: checks every payout",
      "Veylo's server: records and relay",
      "Stores team, salaries, schedules and records",
      "Relays signed messages it cannot change",
      "Never sees a key, signs or moves funds",
    ],
  },
];

describe("README diagrams: where they are, and their shape", () => {
  it("every mermaid fence is closed, and every diagram is non-empty and starts with a diagram keyword", () => {
    const lines = readme.split("\n");
    expect(lines.filter((l) => l.trim().startsWith("```")).length % 2).toBe(0);
    const opened = lines.filter((l) => l.trim() === "```mermaid").length;
    expect(diagrams).toHaveLength(opened);
    for (const d of diagrams) {
      expect(d.code.trim(), `${d.title} is empty`).not.toBe("");
      expect(firstCodeLine(d.code), `${d.title} starts with an unknown keyword`).toMatch(
        DIAGRAM_START,
      );
    }
  });

  it("has at least the seven diagrams", () => {
    expect(WANTED).toHaveLength(7);
    expect(diagrams.length).toBeGreaterThanOrEqual(WANTED.length);
    const titles = diagrams.map((d) => d.title);
    expect(new Set(titles).size, "two diagrams share a title").toBe(titles.length);
  });

  it.each(WANTED)(
    "$title: in $section, a bold title above, a one-line caption below, the right kind",
    (want) => {
      const found = diagrams.filter((d) => d.title === `**${want.title}**`);
      expect(found).toHaveLength(1);
      const d = found[0];
      expect(d?.section).toBe(want.section);
      expect(
        d?.shaped,
        "title, fence and caption are not laid out as title / diagram / caption",
      ).toBe(true);
      expect(firstCodeLine(d?.code ?? "")).toBe(want.start);
    },
  );

  it.each(WANTED)("$title: shows what it should, and nothing is out of order", (want) => {
    const code = diagrams.find((d) => d.title === `**${want.title}**`)?.code ?? "";
    for (const text of want.needs) expect(code, `${want.title} omits: ${text}`).toContain(text);
    if (want.order) inOrder(code, want.order);
  });

  it("leaves the Contents list and the section order as they were", () => {
    expect(headings).toEqual(ORDER);
    const links = [...section("Contents").matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] ?? "");
    expect(links).toEqual(ORDER.filter((h) => h !== "Contents").map(slug));
    expect(section("Contents").trim().split("\n")).toHaveLength(18);
  });

  it("the private and direct diagram's caption carries the evidence condition, verbatim", () => {
    const d = diagrams.find((x) => x.title === `**${PRIVATE_AND_DIRECT}**`);
    expect(d?.caption).toContain(EVIDENCE_CONDITION);
    expect(readme.split(EVIDENCE_CONDITION).length - 1).toBeGreaterThanOrEqual(3);
  });
});

describe("README diagrams: plain Mermaid, in the Veylo palette", () => {
  it("has no click, style, init, link or HTML, and no emoji", () => {
    for (const d of diagrams) {
      for (const line of d.code.split("\n").map((l) => l.trim()))
        expect(line, `${d.title}: ${line}`).not.toMatch(
          /^(?:click|style|linkStyle|%%\{|accTitle)\b/,
        );
      expect(d.code, d.title).not.toMatch(/https?:|href|javascript:|<\/?[a-z]/i);
      for (const label of labelsOf(d.code)) {
        expect(label, `${d.title}: ${label}`).not.toMatch(/[<>]/);
        expect(label, `${d.title}: ${label}`).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });

  it("every colour is a Veylo token, and amber appears only in the private diagram", () => {
    const tokens = read("apps/web/src/design/tokens.ts").toUpperCase();
    const AMBER = ["#FFF0D4", "#F5B94A", "#7A5200"];
    for (const d of diagrams) {
      for (const hex of d.code.match(/#[0-9A-Fa-f]{6}\b/g) ?? [])
        expect(tokens, `${hex} in ${d.title} is not in tokens.ts`).toContain(hex.toUpperCase());
      const usesAmber = AMBER.some((h) => d.code.toUpperCase().includes(h));
      expect(usesAmber, `${d.title}: amber is for private only`).toBe(
        d.title === `**${PRIVATE_AND_DIRECT}**`,
      );
    }
  });

  it("each colour class means one thing, in every flowchart", () => {
    const stroke = {
      actor: "#5B6CFF",
      keys: "#0A0E1F",
      ok: "#1E9E6A",
      bad: "#C2410C",
      amber: "#F5B94A",
      later: "#8A90A8",
    };
    for (const d of diagrams.filter((x) => firstCodeLine(x.code).startsWith("flowchart"))) {
      const defs = classDefs(d.code);
      expect(defs.length, `${d.title} has no classDef`).toBeGreaterThan(0);
      for (const def of defs) {
        const want = stroke[def.name as keyof typeof stroke];
        expect(want, `${d.title}: unknown class ${def.name}`).toBeTruthy();
        expect(def.style.toUpperCase(), `${d.title}: ${def.name}`).toContain(`STROKE:${want}`);
      }
    }
  });

  it("every node of every flowchart has a class, and every class is defined and used", () => {
    for (const d of diagrams.filter((x) => firstCodeLine(x.code).startsWith("flowchart"))) {
      const ids = nodeIds(d.code);
      expect(ids.length, `${d.title} has no nodes`).toBeGreaterThan(3);
      const defined = new Set(classDefs(d.code).map((c) => c.name));
      const uses = classUses(d.code);
      const styled = new Set(uses.flatMap((u) => u.ids));
      for (const id of ids)
        expect(styled.has(id), `${d.title}: node ${id} has no class`).toBe(true);
      for (const id of styled)
        expect(ids.includes(id), `${d.title}: class on unknown node ${id}`).toBe(true);
      for (const u of uses)
        expect(defined.has(u.name), `${d.title}: class ${u.name} is not defined`).toBe(true);
      for (const name of defined)
        expect(
          uses.some((u) => u.name === name),
          `${d.title}: classDef ${name} is unused`,
        ).toBe(true);
    }
  });
});

describe("README diagrams: true to the code", () => {
  it("every 1Click call in a diagram is one the client makes, and the sequence matches the pay run table", () => {
    const client = read("packages/intents/src/oneclick-treasury.ts");
    const calls = new Set(diagrams.flatMap((d) => d.code.match(/\/v0\/[a-z-]+/g) ?? []));
    expect(calls.size).toBeGreaterThanOrEqual(4);
    for (const call of calls) expect(client, `the client never calls ${call}`).toContain(call);
    const sequence = diagrams.find((d) => d.title === "**The pay run as a sequence**")?.code ?? "";
    const table = firstTable(section("The pay run, step by step")).rows;
    for (const row of table)
      expect(sequence, `step ${row[0]} ${row[1]}`).toContain(`${row[0]} ${row[1]}`);
  });

  it("the gates diagram runs the checks in the order the code runs them, with the amount rule the code has", () => {
    const gates = read("apps/web/src/gates/index.ts");
    const run = gates.slice(gates.indexOf("export async function runGates"));
    const calls = ['guarded("A"', 'guarded("deadline"', 'guarded("B"', "gateB2(", 'guarded("C"'];
    const at = calls.map((c) => run.indexOf(c));
    expect(
      at.every((p) => p > 0),
      "runGates no longer runs A, deadline, B, B2, C",
    ).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(gates).toContain("amountOut / 100n");
    expect(gates).toContain("1_000_000n");
    const code = diagrams.find((d) => d.title === "**How the gates decide**")?.code ?? "";
    inOrder(code, ["Gate A:", "Time left:", "Gate B:", "Gate B2:", "Gate C:"]);
  });

  it("the funding diagram's options are the ones the Fund screen enables or marks coming soon", () => {
    const code = diagrams.find((d) => d.title === "**Funding the treasury**")?.code ?? "";
    const routes = read("packages/core/src/routes.ts");
    expect(routes).toMatch(/"usdc-near": "enabled"/);
    expect(routes).toMatch(/near: "coming_soon"/);
    expect(routes).toMatch(/"usdt-near": "coming_soon"/);
    expect(code).toContain("NEAR, or USDT on NEAR: coming soon");
  });

  it("the cron routes in the architecture diagram are the ones the API schedules", () => {
    const code = diagrams.find((d) => d.title === "**System architecture**")?.code ?? "";
    const build = read("apps/api/build-vercel.mjs");
    for (const job of ["settlement", "prepare-drafts"]) {
      expect(build).toContain(`/internal/cron/${job}`);
      expect(code).toContain(`"${job}"`);
    }
  });
});

describe("README diagrams: the claims guard reads their text", () => {
  const text = diagrams.flatMap((d) => [d.title, ...labelsOf(d.code), d.caption]);

  it("has diagram text to read", () => {
    expect(text.length).toBeGreaterThan(120);
  });

  it("no label, title or caption claims to be first, only or unique, or names what Veylo doesn't offer", () => {
    expect(findClaims(asMarkdown(text.join("\n")))).toEqual([]);
    expect(findNotOffered(asMarkdown(text.join("\n")))).toEqual([]);
  });

  it.each([
    "Earn yield on your treasury",
    "A Visa card for contractors",
    "Spend with a debit card",
    "Cash out through the off-ramp",
    "Earn 5% APY",
    "Treasury interest, paid monthly",
  ])("flags a flowchart label that says: %s", (label) => {
    const code = `flowchart TB\n  x["${label}"]\n`;
    expect(findNotOffered(labelsOf(code).join("\n"))).toHaveLength(1);
  });

  it.each([
    "The first private payroll on NEAR",
    "The only way to pay a team privately",
    "A unique approach to payroll",
  ])("flags a flowchart label that claims: %s", (label) => {
    const code = `flowchart TB\n  x["${label}"]\n`;
    expect(findClaims(labelsOf(code).join("\n"))).toHaveLength(1);
  });

  it("reads a sequence diagram's messages, notes and participants too", () => {
    const code = [
      "sequenceDiagram",
      "  participant A as The first payroll app",
      "  Note over A,B: Earn yield here",
      "  A->>B: The only way to pay",
    ].join("\n");
    const words = labelsOf(code);
    expect(words).toHaveLength(3);
    expect(findClaims(words.join("\n"))).toHaveLength(2);
    expect(findNotOffered(words.join("\n"))).toHaveLength(1);
  });

  it("flags a caption that claims, because a caption is read like any other line", () => {
    expect(findClaims(asMarkdown("_Veylo is the first private payroll on NEAR._"))).toHaveLength(1);
    expect(findNotOffered(asMarkdown("_Earn yield on your balance._"))).toHaveLength(1);
  });
});
