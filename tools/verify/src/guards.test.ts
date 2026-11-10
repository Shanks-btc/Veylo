// Repository rules that a type checker can't enforce. These keep the slice's acceptance criteria true.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SKIP = new Set(["node_modules", "dist", "coverage", "verification", ".git", "migrations"]);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const display = (path: string) => relative(root, path).split(sep).join("/");
const isCode = (path: string) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(path);
const isTest = (path: string) => /\.test\.ts$/.test(path);
const isThisFile = (path: string) => display(path) === "tools/verify/src/guards.test.ts";

const allCode = ["apps", "packages", "tools"]
  .flatMap((d) => filesUnder(join(root, d)))
  .filter(isCode);
const productCode = allCode.filter((p) => !isTest(p) && !isThisFile(p));
const coreDir = join(root, "packages", "core");
const coreCode = filesUnder(join(coreDir, "src")).filter(isCode);
const coreSource = coreCode.filter((p) => !isTest(p));

const importSpecifiers = (text: string) =>
  [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g)].map(
    (m) => m[1] as string,
  );

function offenders(paths: string[], pattern: RegExp): string[] {
  return paths.filter((p) => pattern.test(readFileSync(p, "utf8"))).map(display);
}

describe("packages/core stays pure", () => {
  it("declares no dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.devDependencies ?? {}).toEqual({});
  });

  it("source imports only its own files", () => {
    const external = coreSource.flatMap((p) =>
      importSpecifiers(readFileSync(p, "utf8"))
        .filter((s) => !s.startsWith("./"))
        .map((s) => `${display(p)}: ${s}`),
    );
    expect(external).toEqual([]);
  });

  it("tests import only their own package and the test runner", () => {
    const external = coreCode.filter(isTest).flatMap((p) =>
      importSpecifiers(readFileSync(p, "utf8"))
        .filter((s) => !s.startsWith("./") && s !== "vitest")
        .map((s) => `${display(p)}: ${s}`),
    );
    expect(external).toEqual([]);
  });

  it("source touches no clock, randomness, network, filesystem or environment", () => {
    const io =
      /\b(Date\.now|Math\.random|fetch|process\.|globalThis|setTimeout|setInterval|XMLHttpRequest|WebSocket|localStorage|crypto\.)|new Date\(\s*\)/;
    expect(offenders(coreSource, io)).toEqual([]);
  });
});

describe("no floating point on money", () => {
  it("no parseFloat, parseInt, toFixed or Number(...) anywhere in product code", () => {
    expect(
      offenders(productCode, /\b(parseFloat|parseInt|toFixed|toPrecision)\b|\bNumber\(/),
    ).toEqual([]);
  });

  it("money columns are bigint, or numeric(78,0) for non-USDC assets (L20)", () => {
    const schema = readFileSync(join(root, "packages", "db", "src", "schema.ts"), "utf8");
    expect(schema).not.toMatch(/\b(decimal|real|doublePrecision)\(/);
    const numerics = schema.match(/\bnumeric\([^)]*\)/g) ?? [];
    expect(numerics.filter((n) => !/precision: 78, scale: 0/.test(n))).toEqual([]);
  });
});

describe("verification/ stays separate (L5)", () => {
  it("is not in the pnpm workspace", () => {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).not.toMatch(/verification/);
  });

  it("nothing imports from it", () => {
    const imports = allCode
      .filter((p) => !isThisFile(p))
      .flatMap((p) =>
        importSpecifiers(readFileSync(p, "utf8"))
          .filter((s) => s.includes("verification"))
          .map((s) => `${display(p)}: ${s}`),
      );
    expect(imports).toEqual([]);
  });

  it("no package depends on its Phase 2 libraries", () => {
    const banned = [
      "near-api-js",
      "tronweb",
      "ethers",
      "@defuse-protocol/intents-sdk",
      "@solana/web3.js",
    ];
    const manifests = allCode.length
      ? ["apps", "packages", "tools"]
          .flatMap((d) => filesUnder(join(root, d)))
          .filter((p) => p.endsWith("package.json"))
      : [];
    const found = [join(root, "package.json"), ...manifests].flatMap((p) => {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      return names.filter((n) => banned.includes(n)).map((n) => `${display(p)}: ${n}`);
    });
    expect(found).toEqual([]);
  });
});

describe("no secrets", () => {
  it("no .env file exists in the product tree", () => {
    const envFiles = [root, ...["apps", "packages", "tools"].map((d) => join(root, d))]
      .flatMap((d) => (d === root ? readdirSync(d).map((n) => join(d, n)) : filesUnder(d)))
      .filter((p) => /[\\/]\.env(\.[^\\/]*)?$/.test(p) && !p.endsWith(".env.example"));
    expect(envFiles.map(display)).toEqual([]);
  });

  it(".env.example has names and comments only", () => {
    const lines = readFileSync(join(root, ".env.example"), "utf8").split(/\r?\n/);
    const withValues = lines.filter((l) => l && !l.startsWith("#") && !/^[A-Z0-9_]+=$/.test(l));
    expect(withValues).toEqual([]);
  });

  it("every dependency is pinned exactly", () => {
    const manifests = [
      join(root, "package.json"),
      ...["apps", "packages", "tools"]
        .flatMap((d) => filesUnder(join(root, d)))
        .filter((p) => p.endsWith("package.json")),
    ];
    const loose = manifests.flatMap((p) => {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      return Object.entries({ ...pkg.dependencies, ...pkg.devDependencies } as Record<
        string,
        string
      >)
        .filter(([, v]) => !v.startsWith("workspace:") && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v))
        .map(([n, v]) => `${display(p)}: ${n}@${v}`);
    });
    expect(loose).toEqual([]);
  });

  it("the Node pin exists", () => {
    expect(existsSync(join(root, ".nvmrc"))).toBe(true);
    expect(readFileSync(join(root, ".nvmrc"), "utf8").trim()).toMatch(/^24\./);
  });
});
