// pnpm wallets:refresh: re-fetches the near-connect manifest and every executor, prints what
// changed since the committed pins (hash, version and host differences), and writes NOTHING unless
// you pass --write AND set VEYLO_WALLET_PINS_APPROVED=1 (the founder's approval to change pins).
// Pinned wallet code is reviewed code: a changed executor is a reviewed update, never an automatic one.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_URL,
  buildLock,
  diffLocks,
  extOf,
  fetchBytes,
  sha256Hex,
} from "./wallets-lib.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const lockPath = join(web, "src", "wallet", "wallets.lock.json");
const reviewPath = join(web, "src", "wallet", "wallets.review.json");
const write = process.argv.includes("--write");
const approved = process.env.VEYLO_WALLET_PINS_APPROVED === "1";

if (write && !approved) {
  console.error(
    "wallets:refresh: --write needs VEYLO_WALLET_PINS_APPROVED=1, the founder's approval to change the pins. Nothing was written.",
  );
  process.exit(1);
}

const review = JSON.parse(readFileSync(reviewPath, "utf8"));
const oldLock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : undefined;

console.log(`manifest: ${MANIFEST_URL}`);
const manifest = JSON.parse((await fetchBytes(MANIFEST_URL)).bytes.toString("utf8"));
const fetched = new Map();
for (const w of manifest.wallets) {
  const entry = {};
  try {
    entry.executor = (await fetchBytes(w.executor)).bytes;
    const pin = review.wallets[w.id]?.pinned;
    if (pin) {
      const local = readFileSync(join(web, "public", "wallets", pin.file));
      if (sha256Hex(local) !== pin.sha256) throw new Error(`${pin.file} does not match its pin`);
      if (sha256Hex(entry.executor) !== pin.sha256)
        entry.upstream = { sha256: sha256Hex(entry.executor), bytes: entry.executor.length };
      entry.executor = local;
    }
    console.log(
      `  ${w.id}: executor ${sha256Hex(entry.executor).slice(0, 12)}... ${entry.executor.length} bytes`,
    );
  } catch (err) {
    console.error(`  ${w.id}: executor fetch failed (${err instanceof Error ? err.message : err})`);
    continue;
  }
  try {
    const icon = await fetchBytes(w.icon);
    entry.icon = { bytes: icon.bytes, ext: extOf(w.icon, icon.type) };
  } catch {
    // The picker shows initials when there is no icon.
  }
  fetched.set(w.id, entry);
}

const fresh = buildLock({
  manifest,
  fetched,
  review,
  fetchedAt: new Date().toISOString().slice(0, 10),
});

if (oldLock) {
  const diff = diffLocks(oldLock, fresh);
  console.log(
    diff.length === 0
      ? "\nNo changes since the committed pins."
      : "\nChanges since the committed pins:",
  );
  for (const line of diff) console.log(`  ${line}`);
}
const unreviewed = fresh.wallets.flatMap((w) =>
  w.hosts
    .filter((h) => h.verdict === "unreviewed")
    .map((h) => `${w.id}: ${h.origin} (line ${h.line}, column ${h.col})`),
);
if (unreviewed.length > 0) {
  console.log("\nHosts that need a review in src/wallet/wallets.review.json:");
  for (const u of unreviewed) console.log(`  ${u}`);
}
console.log("\nVerdicts:");
for (const w of fresh.wallets)
  console.log(`  ${w.enabled ? "ENABLED " : "excluded"} ${w.id}: ${w.reason}`);

if (!write) {
  console.log(
    "\nNothing was written. To accept these pins: VEYLO_WALLET_PINS_APPROVED=1 pnpm wallets:refresh -- --write",
  );
  process.exit(0);
}

// Approved: write the lock, the enabled executors under their hash names, and the icons.
const execDir = join(web, "public", "wallets");
const iconDir = join(web, "public", "wallet-icons");
mkdirSync(execDir, { recursive: true });
mkdirSync(iconDir, { recursive: true });
const keepExec = new Set();
const keepIcon = new Set();
for (const w of fresh.wallets) {
  const got = fetched.get(w.id);
  if (w.enabled && got) {
    writeFileSync(join(execDir, w.executor.file), got.executor);
    keepExec.add(w.executor.file);
  }
  if (got?.icon && w.enabled && w.icon.file) {
    writeFileSync(join(iconDir, w.icon.file), got.icon.bytes);
    keepIcon.add(w.icon.file);
  }
}
for (const name of readdirSync(execDir)) if (!keepExec.has(name)) rmSync(join(execDir, name));
for (const name of readdirSync(iconDir)) if (!keepIcon.has(name)) rmSync(join(iconDir, name));
writeFileSync(lockPath, `${JSON.stringify(fresh, null, 2)}\n`);
console.log(`\nWrote ${lockPath}, ${keepExec.size} executor(s) and ${keepIcon.size} icon(s).`);
