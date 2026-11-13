import { describe, expect, it } from "vitest";
import { safeNext, withNext } from "./next";

const TOKEN = "A".repeat(43);

describe("safeNext", () => {
  it("allows the portal's own pages and an invite link", () => {
    expect(safeNext("?next=%2Fportal")).toBe("/portal");
    expect(safeNext("?next=%2Fportal%2Fbalance")).toBe("/portal/balance");
    expect(safeNext(`?next=${encodeURIComponent(`/portal/accept?token=${TOKEN}`)}`)).toBe(
      `/portal/accept?token=${TOKEN}`,
    );
  });

  it("refuses everything else: other sites, other paths, scripts, lookalikes", () => {
    for (const bad of [
      "https://evil.example/portal",
      "//evil.example",
      "/\\evil.example",
      "/app",
      "/app/settings",
      "/portal/../app",
      "/portalx",
      "/portal/accept?token=short",
      "/portal/accept?token=" + TOKEN + "&x=1",
      "javascript:alert(1)",
      "",
    ]) {
      expect(safeNext(`?next=${encodeURIComponent(bad)}`), bad).toBeUndefined();
    }
    expect(safeNext("")).toBeUndefined();
  });
});

describe("withNext", () => {
  it("keeps a safe way back and drops an unsafe one", () => {
    expect(withNext("/app/sign-up", "?next=%2Fportal")).toBe("/app/sign-up?next=%2Fportal");
    expect(withNext("/app/sign-up", `?next=${encodeURIComponent("https://evil.example")}`)).toBe(
      "/app/sign-up",
    );
    expect(withNext("/app/sign-up", "")).toBe("/app/sign-up");
  });
});
