// The CSP and wallet pins (T-7, §15 rule 4).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyPolicy,
  assertOrigins,
  buildPolicy,
  deferHydration,
  inspectHtml,
} from "../scripts/csp-lib.mjs";
import { bridgePolicy } from "../scripts/bridge-csp.mjs";
import { ENABLED_WALLETS, walletById } from "./wallet/registry.js";

const policy = (hashes: string[] = []) =>
  buildPolicy({
    apiOrigin: "https://api.veylo.test",
    nearRpcUrl: "https://rpc.fastnear.com",
    bridgeOrigin: "https://wallet.veylo.test",
    scriptHashes: hashes,
  }) as string;

describe("Content-Security-Policy", () => {
  it("never allows inline or eval, connects only to self, the API and NEAR RPC, and frames only the wallet bridge", () => {
    const p = policy(["'sha256-abc'"]);
    expect(p).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|\*/);
    expect(p).toContain("default-src 'none'");
    expect(p).toContain("script-src 'self' 'sha256-abc'");
    expect(p).toContain("connect-src 'self' https://api.veylo.test https://rpc.fastnear.com;");
    expect(p).toContain("frame-src https://wallet.veylo.test;");
    expect(p).not.toMatch(/meteorwallet/);
    expect(p).toContain("object-src 'none'");
    expect(p).toContain("base-uri 'none'");
  });

  it("allows the read-only archival NEAR RPC for the proof pages, and nothing else new", () => {
    const p = buildPolicy({
      apiOrigin: "https://api.veylo.test",
      nearRpcUrl: "https://rpc.fastnear.com",
      archivalRpcUrl: "https://archival-rpc.mainnet.fastnear.com",
      bridgeOrigin: "https://wallet.veylo.test",
      scriptHashes: [],
    });
    expect(p).toContain(
      "connect-src 'self' https://api.veylo.test https://rpc.fastnear.com https://archival-rpc.mainnet.fastnear.com;",
    );
    expect(p).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it("refuses a wallet bridge on the API origin", () => {
    expect(() =>
      buildPolicy({
        apiOrigin: "https://api.veylo.test",
        nearRpcUrl: "https://rpc.fastnear.com",
        bridgeOrigin: "https://api.veylo.test",
        scriptHashes: [],
      }),
    ).toThrow(/bridge/);
  });
});

describe("local origins never reach a production build (slice W5, part B)", () => {
  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3001",
    "https://localhost",
    "http://[::1]:3000",
    "http://app.veylo.test",
  ])("a production build refuses %s", (origin) => {
    expect(() => assertOrigins([origin], false)).toThrow(/isn't allowed in a production build/);
  });

  it("a production build accepts https origins that aren't this computer", () => {
    expect(() =>
      assertOrigins(
        ["https://app.veylo.test", "https://wallet.veylo.test", "https://rpc.fastnear.com"],
        false,
      ),
    ).not.toThrow();
  });

  it("the local wallet test builds with local origins, only when it says so", () => {
    expect(() =>
      assertOrigins(["http://localhost:3000", "http://127.0.0.1:3001"], true),
    ).not.toThrow();
  });
});

describe("wallet bridge CSP (L44)", () => {
  const meteor = walletById("meteor-wallet")!;
  const p = bridgePolicy({
    appOrigin: "https://app.veylo.test",
    nearRpcUrl: "https://rpc.fastnear.com",
    apiOrigin: "https://api.veylo.test",
    wallet: meteor,
  });
  it("connects only to the wallet reviewed hosts and NEAR RPC, never the API", () => {
    expect(p.connect).toEqual([...(meteor.allow.connect as string[]), "https://rpc.fastnear.com"]);
    expect(p.header).not.toContain("api.veylo.test");
    expect(p.meta).not.toContain("api.veylo.test");
  });
  it("may be framed only by the app origin", () => {
    expect(p.header).toContain("frame-ancestors https://app.veylo.test");
    expect(p.header.match(/frame-ancestors [^;]*/)?.[0]).toBe(
      "frame-ancestors https://app.veylo.test",
    );
  });
  it("fails the build if the API origin would be reachable", () => {
    expect(() =>
      bridgePolicy({
        appOrigin: "https://app.veylo.test",
        nearRpcUrl: "https://api.veylo.test/rpc",
        apiOrigin: "https://api.veylo.test",
        wallet: meteor,
      }),
    ).toThrow(/API origin/);
  });

  it("pins each inline script by its SHA-256, skipping data blocks", () => {
    const body = 'self.__next_f.push([1,"x"])';
    const html = `<html><head><meta charset="utf-8"></head><body><script>${body}</script><script src="/_next/a.js"></script><script type="application/json">{"a":1}</script></body></html>`;
    const expected = `'sha256-${createHash("sha256").update(body).digest("base64")}'`;
    expect(inspectHtml(html)).toEqual([expected]);
    const out = applyPolicy(html, policy([expected])) as string;
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<script"));
    expect(
      out.startsWith(
        '<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"',
      ),
    ).toBe(true);
  });

  it.each([
    ['<button onclick="pay()">x</button>', /event handler/],
    ['<a href="javascript:alert(1)">x</a>', /javascript: URL/],
    ['<script src="https://cdn.example/x.js"></script>', /external/],
    ['<script src="//cdn.example/x.js"></script>', /external/],
  ])("fails the build on %s", (snippet, error) => {
    expect(() => inspectHtml(`<html><head></head><body>${snippet}</body></html>`)).toThrow(error);
  });
});

describe("landing hydration waits for load (W6, W5 follow-up 1)", () => {
  const page =
    '<html><head><link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/webpack-1.js"/></head><body><main>text</main>' +
    '<script src="/_next/static/chunks/a-1.js" async=""></script>' +
    '<script src="/_next/static/chunks/webpack-1.js" id="_R_" async=""></script>' +
    "<script>self.__next_f=[]</script></body></html>";

  it("moves every async Next script behind the load event, keeping ids, and drops script preloads", () => {
    const out = deferHydration(page);
    expect(out).not.toMatch(/<script src=/);
    expect(out).not.toContain('rel="preload" as="script"');
    expect(out).toContain("/_next/static/chunks/a-1.js");
    expect(out).toContain("/_next/static/chunks/webpack-1.js|_R_");
    expect(out).toContain("addEventListener('load'");
    expect(out).toContain("<main>text</main>");
  });

  it("the loader is one inline script the CSP step can pin, and nothing else becomes inline", () => {
    const hashes = inspectHtml(deferHydration(page), "index.html");
    expect(hashes).toHaveLength(2); // Next's own inline data script and the loader.
  });

  it("leaves a page with no Next scripts alone", () => {
    expect(deferHydration("<html><body>plain</body></html>")).toBe(
      "<html><body>plain</body></html>",
    );
  });
});
