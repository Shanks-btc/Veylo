// `pnpm test:pg`: runs the db and api suites against the real Postgres server in DATABASE_URL.
// Each test database is created and dropped by the suite, so the URL's role needs CREATEDB.
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

if (!process.env.DATABASE_URL?.trim()) {
  console.error("Refusing to run: test:pg needs DATABASE_URL.");
  process.exit(1);
}

// The boot smoke tests start the built server and worker, so build first.
const build = spawnSync(process.execPath, [join(root, "apps", "api", "build.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const result = spawnSync(
  process.execPath,
  [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "packages/db", "apps/api"],
  { cwd: root, stdio: "inherit", env: { ...process.env, VEYLO_TEST_PG: "1" } },
);
process.exit(result.status ?? 1);
