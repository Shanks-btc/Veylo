// Design guards (slice W2): colours only from tokens, amber only for private, green only for
// success, red only for errors, every image with alt text, and reduced motion honoured.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const web = fileURLToPath(new URL("../..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", "out", "public", "fixtures"]);

function files(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...files(path, exts));
    } else if (exts.some((e) => name.endsWith(e))) out.push(path);
  }
  return out;
}
const rel = (p: string) => relative(web, p).replaceAll("\\", "/");
const product = () =>
  [...files(join(web, "src"), [".ts", ".tsx", ".css"]), ...files(join(web, "scripts"), [".mjs"])]
    .filter((p) => !p.endsWith(".test.ts"))
    .filter((p) => !["src/design/tokens.ts", "src/design/tokens.css"].includes(rel(p)));

/** Every CSS rule: its selector and its declarations (innermost blocks, so @media is fine). */
function rules(css: string): { selector: string; body: string }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? "").trim(),
    body: m[2] ?? "",
  }));
}

/** Rules whose declarations use a token family must have every selector naming that meaning. */
function misuse(token: RegExp, meaning: RegExp, allow: readonly string[] = []): string[] {
  const bad: string[] = [];
  for (const file of files(join(web, "src"), [".css"])) {
    if (rel(file) === "src/design/tokens.css") continue;
    for (const r of rules(readFileSync(file, "utf8"))) {
      if (!token.test(r.body)) continue;
      for (const sel of r.selector.split(",").map((s) => s.trim())) {
        if (!meaning.test(sel) && !allow.includes(sel)) bad.push(`${rel(file)}: ${sel}`);
      }
    }
  }
  return bad;
}

describe("colour tokens", () => {
  it("no literal hex colour outside src/design/tokens.ts", () => {
    const hits: string[] = [];
    for (const f of product()) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/.test(line))
            hits.push(`${rel(f)}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("amber (private) is used only for things that are private", () => {
    // `.band` is the quote band, whose amber glow the founder's W2 brief asks for explicitly.
    expect(misuse(/var\(--(c-private|private-)/, /priv|veil/i, [".band"])).toEqual([]);
    // In script, amber is read only by the globe (private arcs and the veil) and the OG image's
    // "Keep payroll private." line.
    const scripts = product().filter((f) => /\.(tsx?|mjs)$/.test(f));
    const users = scripts.filter((f) =>
      /color\.private\b|color\.privateInk/.test(readFileSync(f, "utf8")),
    );
    expect(users.map(rel).sort()).toEqual(["scripts/images.mjs", "src/landing/globe.tsx"]);
  });

  it("green is used only for success or passed checks", () => {
    expect(misuse(/var\(--(c-success|success-)/, /success|pass|payable|ok\b/i)).toEqual([]);
  });

  it("red is used only for errors or refusals", () => {
    expect(misuse(/var\(--(c-error|error-)/, /error|fail|refus|expired|invalid/i)).toEqual([]);
  });
});

describe("images", () => {
  it('every <img> and <Picture> has alt text, or alt="" when decorative', () => {
    const missing: string[] = [];
    for (const f of product().filter((p) => p.endsWith(".tsx"))) {
      for (const m of readFileSync(f, "utf8").matchAll(/<(img|Picture)\b[^>]*>/g)) {
        if (!/\balt=/.test(m[0])) missing.push(`${rel(f)}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("reduced motion", () => {
  const base = readFileSync(join(web, "src/styles/base.css"), "utf8");
  it("the base stylesheet turns off every animation and transition", () => {
    const block =
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(base)?.[1] ?? "";
    expect(block).toMatch(/animation:\s*none !important/);
    expect(block).toMatch(/transition:\s*none !important/);
  });
  it("script animations check prefersReducedMotion first", () => {
    for (const f of [
      "src/landing/globe.tsx",
      "src/landing/story.tsx",
      "src/landing/reveal-controller.tsx",
      "src/ui/card.tsx",
    ]) {
      expect(readFileSync(join(web, f), "utf8"), f).toMatch(/prefersReducedMotion\(\)/);
    }
  });
});

describe("signing claims (W2.1 R1)", () => {
  // Each payout needs its own wallet approval (D2): no copy may claim or imply one signature.
  it("no landing or app copy says one signature pays the run", () => {
    const claims =
      /sign(s|ed)? once|one signature|single signature|one wallet signature|sign \d+ payouts/i;
    const hits = product()
      .filter((f) => /\.(tsx?|mjs)$/.test(f))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${rel(f)}:${i + 1}` }))
          .filter(({ line }) => claims.test(line) && !/^\s*\/\//.test(line)),
      )
      .map((h) => h.at);
    expect(hits).toEqual([]);
  });
});

describe("scope: NEAR-only payroll (L46)", () => {
  // User-facing copy only: the landing page, the app screens and shell, shared UI and page meta.
  const COPY_DIRS = [
    "src/landing",
    "src/screens",
    "src/app-ui",
    "src/app",
    "src/ui",
    "src/site.ts",
  ];
  // Chain names are matched as written (so the word "base" in code isn't a hit); the rest in any case.
  const OUT_OF_SCOPE =
    /\b[Aa][Gg][Ee][Nn][Tt][Ss]?\b|\b[Xx]402\b|HTTP 402|\bBase\b|\bArbitrum\b|\bSolana\b/;
  it("no copy mentions agents, x402, HTTP 402, Base, Arbitrum or Solana", () => {
    const hits = product()
      .filter((f) => /\.(tsx?)$/.test(f) && COPY_DIRS.some((d) => rel(f).startsWith(d)))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${rel(f)}:${i + 1}` }))
          .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && OUT_OF_SCOPE.test(line)),
      )
      .map((h) => `${h.at}: ${h.line.trim().slice(0, 80)}`);
    expect(hits).toEqual([]);
  });
});

describe("responsive rules (W6)", () => {
  const css = (file: string) => readFileSync(join(web, "src", "styles", file), "utf8");
  /** The body of the first rule whose selector list contains `selector` (any @media). */
  const ruleFor = (text: string, selector: string) =>
    rules(text).filter((r) => r.selector.split(",").some((s) => s.trim() === selector));

  it("keeps clear of the notch and the home bar: safe-area insets on the page margins, the bottom bar and sticky actions", () => {
    expect(css("base.css")).toMatch(/\.wrap\s*\{[^}]*env\(safe-area-inset-left/);
    expect(css("base.css")).toMatch(/\.wrap\s*\{[^}]*env\(safe-area-inset-right/);
    const bar = ruleFor(css("app.css"), ".sidebar")
      .map((r) => r.body)
      .join(";");
    expect(bar).toContain("env(safe-area-inset-bottom");
    const sticky = ruleFor(css("w6.css"), ".sticky-actions")
      .map((r) => r.body)
      .join(";");
    expect(sticky).toContain("env(safe-area-inset-bottom");
  });

  it("never blocks zoom: no maximum-scale or user-scalable=no anywhere", () => {
    const hits = product()
      .filter((p) => /\.(tsx?|mjs)$/.test(p))
      .filter((p) =>
        /user-scalable\s*=\s*no|maximum-scale\s*=\s*1\b|userScalable:\s*false|maximumScale:\s*1\b/.test(
          readFileSync(p, "utf8"),
        ),
      )
      .map(rel);
    expect(hits).toEqual([]);
  });

  it("has the phone rules the brief names: a bottom bar, stacked table cards, sticky actions, full-height sheets", () => {
    const all = ["app.css", "ui.css", "w6.css"].map(css).join("\n");
    expect(all).toMatch(/@media \(max-width: 900px\)[\s\S]*\.sidebar[\s\S]*position: fixed/);
    expect(all).toMatch(/\.sticky-actions[\s\S]*position: sticky/);
    expect(all).toMatch(/dialog[\s\S]*100dvh|\.sheet[\s\S]*100dvh|max-height: 100dvh/);
    expect(all).toMatch(/\.table[\s\S]*display: block/);
  });
});
