// No dead links (slice W6, part 1). The browser crawler (scripts/pages-check.mjs crawl) is the full
// check on the built app; this is the fast one, over the source: every internal link a person can
// click, in the landing page, the screens, the shell and the public frame, names a page that exists,
// and every #fragment names an id that exists on that page. A link to "#" that goes nowhere fails.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL(".", import.meta.url));
const rel = (p: string) => relative(src, p).split(sep).join("/");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Every page of the app: src/app/**\/page.tsx, with route groups like (shell) removed. */
const ROUTES = new Set(
  files(join(src, "app"))
    .filter((f) => f.endsWith("page.tsx"))
    .map((f) => {
      const dir = rel(f)
        .replace(/^app\//, "")
        .replace(/\/?page\.tsx$/, "");
      const path = dir
        .split("/")
        .filter((s) => s && !/^\(.*\)$/.test(s))
        .join("/");
      return `/${path}`;
    }),
);
/** Static files the site serves that a link may point at. */
const STATIC = new Set(["/robots.txt", "/sitemap.xml", "/og.jpg"]);

const SOURCES = files(src).filter(
  (f) =>
    /\.(tsx?)$/.test(f) &&
    !/\.test\.tsx?$/.test(f) &&
    ["landing/", "screens/", "app-ui/", "ui/", "app/"].some((d) => rel(f).startsWith(d)),
);

/** The target of every link written in a source file: href="…", href: "…", ["/…", "label"] and href={`/…`}. */
function linksIn(text: string): { target: string; line: number }[] {
  const found: { target: string; line: number }[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/href\s*[=:]\s*\{?\s*["'`]([^"'`]*)["'`]/g))
      found.push({ target: m[1] ?? "", line: i + 1 });
    for (const m of line.matchAll(/^\s*\[\s*"(\/[^"]*|#)"\s*,\s*"[^"]+"\s*\]/g))
      found.push({ target: m[1] ?? "", line: i + 1 });
  });
  return found;
}

/** The ids a page can offer: id="x" and { id: "x" } anywhere in the public and landing sources. */
const IDS = new Map<string, Set<string>>();
for (const f of SOURCES) {
  const text = readFileSync(f, "utf8");
  const ids = new Set(
    [...text.matchAll(/\bid\s*[=:]\s*\{?\s*["']([\w-]+)["']/g)].map((m) => m[1] ?? ""),
  );
  IDS.set(rel(f), ids);
}
const PAGE_SOURCES: Record<string, string[]> = {
  "/": ["landing/sections.tsx", "landing/nav.tsx", "app/page.tsx"],
  "/docs": ["screens/public-docs.tsx"],
  "/security": ["screens/public-legal.tsx"],
  "/privacy": ["screens/public-legal.tsx"],
  "/terms": ["screens/public-legal.tsx"],
};

describe("links", () => {
  it("knows the pages it is checking against", () => {
    for (const r of [
      "/",
      "/docs",
      "/security",
      "/privacy",
      "/terms",
      "/verify",
      "/proof",
      "/app",
      "/app/fund",
      "/portal",
      "/portal/balance",
      "/app/contractor/add-address",
    ])
      expect(ROUTES.has(r), r).toBe(true);
    expect(ROUTES.size).toBeGreaterThanOrEqual(34);
  });

  it("every internal link goes to a page that exists", () => {
    const dead: string[] = [];
    for (const f of SOURCES) {
      for (const { target, line } of linksIn(readFileSync(f, "utf8"))) {
        if (target === "#" || target === "") {
          dead.push(`${rel(f)}:${line}: a link to ${JSON.stringify(target)} goes nowhere`);
          continue;
        }
        if (/^(https?:|mailto:|tel:|\$\{)/.test(target) || target.includes("${")) continue; // External, or built at run time.
        if (target.startsWith("#")) continue; // Same-page anchors are checked below.
        const [path = ""] = target.split(/[?#]/);
        const clean = path.replace(/\/$/, "") || "/";
        if (!ROUTES.has(clean) && !STATIC.has(clean))
          dead.push(`${rel(f)}:${line}: ${target} is not a page`);
      }
    }
    expect(dead).toEqual([]);
  });

  it("every #fragment names an id that exists on its page", () => {
    const missing: string[] = [];
    for (const f of SOURCES) {
      for (const { target, line } of linksIn(readFileSync(f, "utf8"))) {
        const [path = "", fragment] = target.split("#");
        if (!fragment || /^(https?:|mailto:)/.test(target)) continue;
        const page = path === "" ? undefined : path.replace(/\/$/, "") || "/";
        const owners = page ? PAGE_SOURCES[page] : PAGE_SOURCES["/"];
        if (!owners) continue; // A fragment on a page whose ids are built at run time.
        const have = new Set(owners.flatMap((o) => [...(IDS.get(o) ?? [])]));
        if (page === undefined && !rel(f).startsWith("landing/")) continue;
        if (!have.has(fragment))
          missing.push(`${rel(f)}:${line}: ${target} has no id "${fragment}"`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the footers and the navigation list real pages", () => {
    const text = readFileSync(join(src, "landing", "sections.tsx"), "utf8");
    for (const must of [
      '"/docs"',
      '"/security"',
      '"/privacy"',
      '"/terms"',
      '"/verify"',
      '"/proof"',
    ])
      expect(text, must).toContain(must);
    expect(readFileSync(join(src, "landing", "nav.tsx"), "utf8")).toContain('href: "/docs"');
  });

  it("the detector finds a dead link when one is written", () => {
    expect(linksIn('<a href="/nope">x</a>')).toEqual([{ target: "/nope", line: 1 }]);
    expect(linksIn('      ["/docz", "Docs"],')).toEqual([{ target: "/docz", line: 1 }]);
    expect(linksIn('<a href="#">x</a>')).toEqual([{ target: "#", line: 1 }]);
  });
});
