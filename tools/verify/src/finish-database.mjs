// Finishes the hosted deployment's database step (slice W7), once the Neon Marketplace terms are
// accepted and the install has created its installation: installs Neon on the API project, checks
// that DATABASE_URL and DATABASE_URL_UNPOOLED are set there, applies migrations 0001 to 0017 with the
// UNPOOLED url (a migration needs a real session, not a pooler), redeploys the API, and checks
// /api/ready. It never prints a connection string.
//
//   node tools/verify/src/finish-database.mjs
//
// Run from the repository root with the Vercel CLI logged in. Needs `pnpm build` first (it does that).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const api = join(root, "deploy", "api");
/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
const run = (cmd, args, options = {}) =>
  spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
const step = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) process.exit(1);
};

// 1. Install Neon (free plan, iad1, Neon Auth off), connected to production only. Skipped when the
// database is already connected (running the install again would create a second, unconnected one).
const have = (/** @type {string} */ name) =>
  new RegExp(`^\\s*${name}\\s`, "m").test(
    run("vercel", ["env", "ls", "production", "--cwd", api]).stdout,
  );
if (have("DATABASE_URL") && have("DATABASE_URL_UNPOOLED")) {
  step("Neon is already installed and connected to the API project", true);
} else {
  const install = run("vercel", [
    "integration",
    "add",
    "neon",
    "--cwd",
    api,
    "--name",
    "veylo-db",
    "-m",
    "region=iad1",
    "-m",
    "auth=false",
    "-e",
    "production",
    "--no-env-pull",
    "--plan",
    "free_v3",
    "--non-interactive",
  ]);
  const text = `${install.stdout}${install.stderr}`;
  if (/integration_terms_acceptance_required/.test(text)) {
    step(
      "Neon install",
      false,
      "the Marketplace terms are not accepted for this team yet (no Neon installation exists)",
    );
  }
  step("Neon install", install.status === 0, install.status === 0 ? "" : text.slice(-300));
}

// 2. Both variables are set on the API project (names only; values are never read here).
const names = run("vercel", ["env", "ls", "production", "--cwd", api]).stdout;
for (const name of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"])
  step(`${name} is set on the API project`, new RegExp(`^\\s*${name}\\s`, "m").test(names));

// 3. Migrate with the unpooled url, pulled into a temp file that is deleted straight after.
const work = mkdtempSync(join(tmpdir(), "veylo-db-"));
const file = join(work, ".env.production");
try {
  const pull = run("vercel", [
    "env",
    "pull",
    file,
    "--environment",
    "production",
    "--cwd",
    api,
    "--yes",
  ]);
  step("pulled the production variables to a temporary file", pull.status === 0);
  const env = Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((l) => {
        const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(l);
        return m ? [[m[1], m[2]]] : [];
      }),
  );
  step("DATABASE_URL_UNPOOLED has a value", Boolean(env.DATABASE_URL_UNPOOLED));
  const build = run("pnpm", ["build"]);
  step("pnpm build", build.status === 0);
  const migrate = run("pnpm", ["db:migrate"], {
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL_UNPOOLED },
  });
  step(
    "migrations applied",
    migrate.status === 0,
    migrate.status === 0
      ? migrate.stdout.trim().split("\n").slice(-1)[0]
      : "see the migration output",
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 4. Redeploy the API so it boots with the database, then check readiness.
const built = run("node", [join(root, "apps", "api", "build-vercel.mjs")]);
step("API bundle built", built.status === 0);
const deploy = run("vercel", [
  "deploy",
  "--prebuilt",
  "--prod",
  "--yes",
  "--non-interactive",
  "--cwd",
  api,
]);
step("API redeployed", deploy.status === 0);
let ready = "";
for (let i = 0; i < 6 && !/"ready"/.test(ready); i += 1) {
  await new Promise((r) => setTimeout(r, 4000));
  ready = await fetch("https://veylopay.vercel.app/api/ready")
    .then((r) => r.text())
    .catch(() => "");
}
step(
  "GET /api/ready answers ready (database up, no migration pending)",
  /"ready"/.test(ready),
  ready.slice(0, 80),
);
