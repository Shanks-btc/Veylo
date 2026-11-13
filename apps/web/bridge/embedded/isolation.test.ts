// The Veylo wallet page can't send anything anywhere (slice W6). Besides the page CSP
// (connect-src 'none'), the source itself holds no network API, imports only the code it needs,
// and never mentions the Veylo API, the app's session or the email login.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL(".", import.meta.url));
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));
const code = (text: string) =>
  text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("the wallet page's source", () => {
  it("has files to check", () => {
    expect(sources.map((s) => s.file).sort()).toEqual(
      [
        "derive.ts",
        "describe.ts",
        "flow.ts",
        "main.ts",
        "store.ts",
        "ui.ts",
        "vault.ts",
        "webauthn.ts",
      ].sort(),
    );
  });

  it.each([
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "sendBeacon",
    "importScripts",
    "postMessage",
  ])("never uses %s, except the one postMessage to the app that framed it", (api) => {
    for (const s of sources) {
      const uses = new RegExp(`\b${api}\b`).test(code(s.text));
      if (api === "postMessage") expect(uses && s.file !== "main.ts", s.file).toBe(false);
      else expect(uses, `${s.file} uses ${api}`).toBe(false);
    }
  });

  it("imports only crypto libraries, its own files and the bridge's shared types", () => {
    const allowed =
      /^(\.\/|\.\.\/handler|\.\.\/\.\.\/src\/wallet\/(bridge-protocol|types)|@noble\/|@scure\/|@veylo\/intents$)/;
    for (const s of sources)
      for (const m of code(s.text).matchAll(/^import[^;]*?from "([^"]+)"/gms))
        expect(allowed.test(m[1] ?? ""), `${s.file} imports ${m[1]}`).toBe(true);
  });

  it("never names the Veylo API, a session, a cookie or the email login", () => {
    for (const s of sources)
      expect(code(s.text), s.file).not.toMatch(
        /api\/client|createApiClient|document\.cookie|localStorage|sessionStorage|\/auth\/|password-hash|emailPassword/,
      );
  });

  it("keeps the secret out of the page's text and attributes", () => {
    // The screens show the phrase words and nothing else secret; entropy and keys never reach the DOM.
    const ui = code(sources.find((s) => s.file === "ui.ts")?.text ?? "");
    expect(ui).not.toMatch(/entropy|secret|keyFrom|ed25519/);
  });
});
