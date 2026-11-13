// Mainnet spikes never run by accident (slice W6): every spike that moves or spends real funds
// refuses to start unless the founder's approval variable is exactly "yes", and the refusal comes
// before any network call, signature or transaction. This runs each one WITHOUT its approval and
// requires it to stop. (A spike with no approval variable would fail the first check.)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scripts = join(root, "verification", "scripts");
// verification/ is its own npm package, not part of the pnpm workspace: a clean checkout hasn't run
// `npm ci` in it, and then the scripts can't load at all (which is safe, but can't show their refusal).
// The order check below always runs; running the scripts needs the package installed.
const TSX = join(root, "verification", "node_modules", "tsx", "dist", "cli.mjs");
const installed = existsSync(TSX);

const SPIKES = [
  { file: "s-n-near-direct.ts", variable: "S_N_FOUNDER_APPROVED" },
  { file: "s-p-cashout.ts", variable: "S_P_FOUNDER_APPROVED" },
  { file: "s-f1-fund-usdc-near.ts", variable: "S_F1_FOUNDER_APPROVED" },
  { file: "s-f2-fund-near.ts", variable: "S_F2_FOUNDER_APPROVED" },
  { file: "s-ft-fund-usdt.ts", variable: "S_FT_FOUNDER_APPROVED" },
  { file: "s-nr-near-payout.ts", variable: "S_NR_FOUNDER_APPROVED" },
  { file: "s-ew-embedded-wallet.ts", variable: "S_EW_FOUNDER_APPROVED" },
] as const;

/** Anything that reaches the network, signs, or sends a transaction. */
const DOES_SOMETHING =
  /\bfetch\(|\bapi\(|liveQuote\(|signAndSubmit\(|\.transfer\(|callFunctionRaw\(|intentsBalance\(|listedPrice\(|viewText\(|nativeBalance\(|signNep413Message\(|await import\(/;

describe.each(SPIKES)("$file", ({ file, variable }) => {
  const source = readFileSync(join(scripts, file), "utf8");
  const lines = source.split("\n");

  it(`asks for ${variable}=yes before it does anything`, () => {
    const gate = lines.findIndex((l) => l.includes(variable) && /"yes"|approve\(/.test(l));
    expect(gate, `${file} has no approval check`).toBeGreaterThanOrEqual(0);
    // Nothing above the approval check (imports and comments aside) may touch the network or sign.
    const above = lines.slice(0, gate).filter((l) => !/^\s*(\/\/|\*|\/\*|import )/.test(l));
    expect(above.filter((l) => DOES_SOMETHING.test(l))).toEqual([]);
  });
  it.skipIf(!installed)(
    "stops, with a non-zero exit, when the approval variable is not set",
    () => {
      const env = { ...process.env };
      for (const s of SPIKES) delete env[s.variable];
      const run = spawnSync(process.execPath, [TSX, join(scripts, file)], {
        cwd: join(root, "verification"),
        env: { ...env, ONECLICK_JWT: "", TREASURY_ACCOUNT_ID: "" },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("STOPPED");
      expect(run.stdout).toContain(variable);
    },
  );

  it.skipIf(!installed)("is also refused when the variable is set to anything but yes", () => {
    const run = spawnSync(process.execPath, [TSX, join(scripts, file)], {
      cwd: join(root, "verification"),
      env: { ...process.env, [variable]: "true", ONECLICK_JWT: "", TREASURY_ACCOUNT_ID: "" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("STOPPED");
  });
});
