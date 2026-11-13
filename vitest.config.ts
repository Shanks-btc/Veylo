import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web app keeps JSX for Next (tsconfig "preserve"); tests compile it with the automatic runtime.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: [
      "apps/*/src/**/*.test.ts",
      "apps/*/bridge/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "tools/*/src/**/*.test.ts",
    ],
    // Every database test applies migrations to a fresh embedded Postgres.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
