// The hosted deployment's staging (slice W7): the web project forwards /api to the API and nothing
// else, refuses local or identical origins, keeps the project link, and the reviewed headers file
// itself never carries a rewrite.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const web = fileURLToPath(new URL("..", import.meta.url));
const script = join(web, "scripts", "stage-hosted.mjs");
const ORIGINS = {
  VEYLO_WEB_ORIGIN: "https://web.example.test",
  VEYLO_BRIDGE_ORIGIN: "https://bridge.example.test",
  VEYLO_API_ORIGIN: "https://api.example.test",
};

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "veylo-stage-"));
  mkdirSync(join(work, "out"), { recursive: true });
  writeFileSync(join(work, "out", "index.html"), "<html></html>");
  mkdirSync(join(work, "bridge", "embedded"), { recursive: true });
  writeFileSync(join(work, "bridge", "embedded", "index.html"), "<html></html>");
  writeFileSync(join(work, "bridge", "vercel.json"), JSON.stringify({ headers: [] }));
  // A project link that staging must keep.
  mkdirSync(join(work, "deploy", "web", ".vercel"), { recursive: true });
  writeFileSync(join(work, "deploy", "web", ".vercel", "project.json"), "{}");
  writeFileSync(join(work, "deploy", "web", "stale.html"), "old");
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

const stage = (env: Record<string, string>) =>
  spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      VEYLO_DEPLOY_DIR: join(work, "deploy"),
      VEYLO_WEB_DIR: join(work, "out"),
      VEYLO_BRIDGE_DIR: join(work, "bridge"),
      ...env,
    },
  });

describe("apps/web/vercel.json (the reviewed headers)", () => {
  it("has no rewrite: the origin-specific part is added by staging", () => {
    const file = JSON.parse(readFileSync(join(web, "vercel.json"), "utf8"));
    expect(file.rewrites).toBeUndefined();
    expect(file.headers[0].source).toBe("/(.*)");
  });
});

describe("staging the hosted web project", () => {
  it("adds exactly one rewrite, /api to the API origin, and no-store for it", () => {
    const run = stage(ORIGINS);
    expect(run.status, run.stderr).toBe(0);
    const staged = JSON.parse(readFileSync(join(work, "deploy", "web", "vercel.json"), "utf8"));
    expect(staged.rewrites).toEqual([
      { source: "/api/:path*", destination: "https://api.example.test/:path*" },
    ]);
    const api = staged.headers.find((h: { source: string }) => h.source === "/api/(.*)");
    expect(api.headers).toEqual([{ key: "Cache-Control", value: "no-store" }]);
    // The reviewed headers are all still there, first.
    const reviewed = JSON.parse(readFileSync(join(web, "vercel.json"), "utf8"));
    expect(staged.headers[0]).toEqual(reviewed.headers[0]);
    expect(staged.cleanUrls).toBe(true);
  });

  it("keeps the project link, drops stale files, and copies the build", () => {
    stage(ORIGINS);
    expect(readFileSync(join(work, "deploy", "web", ".vercel", "project.json"), "utf8")).toBe("{}");
    expect(() => readFileSync(join(work, "deploy", "web", "stale.html"))).toThrow();
    expect(readFileSync(join(work, "deploy", "web", "index.html"), "utf8")).toBe("<html></html>");
    expect(readFileSync(join(work, "deploy", "wallet", "embedded", "index.html"), "utf8")).toBe(
      "<html></html>",
    );
  });

  it.each([
    ["a local origin", { VEYLO_API_ORIGIN: "https://localhost" }],
    ["an http origin", { VEYLO_API_ORIGIN: "http://api.example.test" }],
    ["an origin with a path", { VEYLO_API_ORIGIN: "https://api.example.test/v1" }],
    ["the same origin for two projects", { VEYLO_BRIDGE_ORIGIN: "https://web.example.test" }],
    ["a missing origin", { VEYLO_WEB_ORIGIN: "" }],
  ])("refuses %s", (_label, change) => {
    const run = stage({ ...ORIGINS, ...change });
    expect(run.status).not.toBe(0);
  });
});
