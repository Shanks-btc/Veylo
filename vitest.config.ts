import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "tools/*/src/**/*.test.ts"],
    // Every database test applies migrations to a fresh embedded Postgres.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
