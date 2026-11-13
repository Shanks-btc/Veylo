// Local currencies are display only (slice W6, part 3c): the exchange-rate code is never reachable
// from anything that quotes, signs, sizes or settles a payment. This is a static guard over the
// source: a rate used in a payout amount would need one of these names in a money path.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === ".next" || name.startsWith("out"))
      return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const rel = (p: string) => relative(root, p).split("\\").join("/");
const product = (dir: string) =>
  files(join(root, dir)).filter((f) => /\.(ts|tsx|mjs)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f));

/** The names that mean "an exchange rate or a local currency". */
const FX_NAMES =
  /\b(convertUsdUnits|estimateText|formatLocal|parseRate|DISPLAY_CURRENCIES|DISPLAY_CURRENCY_CODES|displayCurrency|FxClient|useFx|FxProvider)\b|\bdeps\.fx\b|from\s+["'][^"']*\/fx(\.js)?["']/;

/** Code that moves, sizes, quotes or checks money. It must not know about rates. */
const MONEY_PATHS = [
  ...product("packages/intents/src"),
  ...product("packages/chains/src"),
  // The display module itself, and the index that re-exports it, are the only core files exempt.
  ...product("packages/core/src").filter(
    (f) => !/^packages\/core\/src\/(fx|index)\.ts$/.test(rel(f)),
  ),
  ...product("apps/api/src").filter(
    (f) =>
      // The display-only files: the rate client, the settings that choose a currency, the portal and
      // contractor routes that store a contractor's choice (a code, never an amount), and wiring.
      !/^apps\/api\/src\/(fx|settings-routes|portal-routes|contractor-routes|reporting-routes|account-routes|org-routes|app|server|test-support)\.ts$/.test(
        rel(f),
      ),
  ),
  ...product("apps/web/src/gates"),
  ...product("apps/web/src/signing"),
  ...product("apps/web/src/portal"),
  ...product("apps/web/src/wallet"),
  ...product("apps/web/src/proof"),
];

describe("display-only currencies", () => {
  it("guards the money paths it is meant to guard", () => {
    expect(MONEY_PATHS.length).toBeGreaterThan(40);
    expect(MONEY_PATHS.map(rel)).toEqual(
      expect.arrayContaining([
        "apps/api/src/payout-routes.ts",
        "apps/api/src/pay-run-routes.ts",
        "apps/api/src/treasury-routes.ts",
        "apps/api/src/settlement.ts",
        "packages/core/src/near-payout.ts",
        "packages/intents/src/oneclick-treasury.ts",
        "apps/web/src/gates/index.ts",
      ]),
    );
  });

  it("the detector catches a rate in a money path", () => {
    for (const bad of [
      'import { estimateText } from "@veylo/core";',
      "const local = convertUsdUnits(amount, rate, ngn);",
      "const rates = await deps.fx.rates();",
      'import { createFxClient } from "./fx.js";',
      "const c = displayCurrency(code);",
    ]) {
      expect(FX_NAMES.test(bad), bad).toBe(true);
    }
    expect(FX_NAMES.test("const amount = parseAmount(text, USDC);")).toBe(false);
  });

  it("no payout, quote, signing, settlement or gate code uses an exchange rate", () => {
    const hits = MONEY_PATHS.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${rel(f)}:${i + 1}` }))
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && FX_NAMES.test(line))
        .map(({ line, at }) => `${at}: ${line.trim().slice(0, 80)}`),
    );
    expect(hits).toEqual([]);
  });

  it("the rate code lives only where it is shown or chosen", () => {
    const users = [...product("apps/api/src"), ...product("apps/web/src"), ...product("packages")]
      .filter((f) => /from\s+["'][^"']*\/fx(\.js|\.tsx?)?["']/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    // The API's rate client is wired in app/server and read by the settings routes; the web's
    // estimate components are used by display screens. Nothing else imports a module named fx.
    expect(users).toEqual(
      [
        "apps/api/src/app.ts",
        "apps/api/src/server.ts",
        "apps/web/src/app-ui/shell.tsx",
        "apps/web/src/screens/contractor.tsx",
        "apps/web/src/screens/contractors.tsx",
        "apps/web/src/screens/portal-balance.tsx",
        "apps/web/src/screens/portal-kit.tsx",
        "apps/web/src/screens/portal.tsx",
        "apps/web/src/screens/settings.tsx",
        "apps/web/src/screens/statements.tsx",
        "packages/core/src/index.ts",
      ].sort(),
    );
  });
});
