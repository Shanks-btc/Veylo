// Dev-only NEAR implicit account for T5c. Usage: npx tsx scripts/t5c-wallet.ts generate | check
// Prints the public account ID and match results only. Never print a key from this file.
import dns from "node:dns";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";

// The network is blocked before the wallet library loads, so these imports stay dynamic.
let networkAttempts = 0;
const blocked = () => {
  networkAttempts++;
  throw new Error("Network access is blocked in t5c-wallet.ts");
};
globalThis.fetch = blocked as typeof fetch;
net.Socket.prototype.connect = blocked as typeof net.Socket.prototype.connect;
dns.lookup = blocked as unknown as typeof dns.lookup;

const { KeyPair, keyToImplicitAddress } = await import("near-api-js");
const { parse } = await import("dotenv");

const ENV_URL = new URL("../.env", import.meta.url);
const TMP_URL = new URL("../.env.tmp", import.meta.url);
const NAMES = ["RECIPIENT_NEAR_ACCOUNT_ID", "RECIPIENT_NEAR_SECRET_KEY"];

function generate() {
  const before = readFileSync(ENV_URL, "utf8");
  const existing = parse(before);
  const occupied = NAMES.filter((name) => existing[name]);
  if (occupied.length) throw new Error(`Refusing to overwrite: ${occupied.join(", ")}`);

  const pair = KeyPair.fromRandom("ed25519");
  const accountId = keyToImplicitAddress(pair.getPublicKey());
  const without = before.split("\n").filter((line) => !NAMES.some((name) => line.startsWith(`${name}=`)) && !line.startsWith("# Dev-only T5c recipient")).join("\n").replace(/\n*$/, "\n");
  const text = `${without}# Dev-only T5c recipient NEAR implicit account ID (never for production).\nRECIPIENT_NEAR_ACCOUNT_ID=${accountId}\n# Dev-only T5c recipient private key (never for production).\nRECIPIENT_NEAR_SECRET_KEY=${pair.toString()}\n`;

  const after = parse(text);
  for (const [name, value] of Object.entries(existing)) {
    if (!NAMES.includes(name) && after[name] !== value) throw new Error("Another .env value would change");
  }
  writeFileSync(TMP_URL, text);
  renameSync(TMP_URL, ENV_URL);
  console.log(`Recipient NEAR implicit: ${accountId}`);
}

async function check() {
  const env = parse(readFileSync(ENV_URL, "utf8"));
  const key = env.RECIPIENT_NEAR_SECRET_KEY as Parameters<typeof KeyPair.fromString>[0];
  const derived = keyToImplicitAddress(KeyPair.fromString(key).getPublicKey());
  console.log(`NEAR: ${derived === env.RECIPIENT_NEAR_ACCOUNT_ID ? "match" : "MISMATCH"}`);
  console.log(`Account ID is 64 lowercase hex: ${/^[0-9a-f]{64}$/.test(env.RECIPIENT_NEAR_ACCOUNT_ID)}`);
  console.log(`Different from the treasury: ${env.RECIPIENT_NEAR_ACCOUNT_ID !== env.TREASURY_ACCOUNT_ID}`);
  const { redact } = await import("../_util.js");
  const out = JSON.stringify(redact({ note: `https://x.test/?a=${env.RECIPIENT_NEAR_SECRET_KEY}&b=1` }));
  console.log(`Redacted by value: ${!out.includes(env.RECIPIENT_NEAR_SECRET_KEY) && out.includes("[REDACTED]")}`);
}

const mode = process.argv[2];
try {
  if (mode === "generate") generate();
  else if (mode === "check") await check();
  else throw new Error("Usage: t5c-wallet.ts generate | check");
  console.log(`Network attempts: ${networkAttempts}`);
} catch (err) {
  const own = err instanceof Error && /^(Refusing|Usage|Another)/.test(err.message);
  console.log(`Failed: ${own ? (err as Error).message : err instanceof Error ? err.name : "unknown error"}`);
  console.log(`Network attempts: ${networkAttempts}`);
  process.exit(1);
}
