// `pnpm demo`: the whole Veylo story in one command, with no keys and no money (slice W5, C4).
// It runs apps/web/src/story/story.test.ts, which prints each numbered check as it passes, and exits
// non-zero if any fails. Nothing leaves this computer: the API runs in-process on a throwaway test
// database, NEAR Intents and NEAR RPC are stand-ins, wallets are throwaway keys, and the privacy
// proof reads recorded NEAR RPC answers.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vitest = join(
  dirname(createRequire(join(root, "package.json")).resolve("vitest/package.json")),
  "vitest.mjs",
);

console.log("Veylo demo: no keys, no money. The whole story, checked step by step.\n");
const started = Date.now();
const run = spawnSync(
  process.execPath,
  [vitest, "run", "apps/web/src/story/story.test.ts", "--reporter=verbose", "--color=false"],
  {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  },
);
const out = `${run.stdout}\n${run.stderr}`;
const checks = [...out.matchAll(/^\s*(✓|×)\s.*?>\s*(\d+\.\s.*?)(?:\s+\d+ms)?$/gm)];
for (const [, mark, title] of checks) console.log(`${mark === "✓" ? "PASS" : "FAIL"}  ${title}`);
const failed = checks.filter((c) => c[1] === "×").length;
const elapsed = Date.now() - started;
const seconds = `${Math.floor(elapsed / 1000)}.${Math.floor((elapsed % 1000) / 100)}`;
if (run.status !== 0 || checks.length === 0 || failed > 0) {
  console.log(`\nFAIL: ${failed} check(s) failed in ${seconds}s. Full output:\n`);
  console.log(out);
  process.exit(1);
}
console.log(`\nPASS: ${checks.length} checks in ${seconds}s.`);
