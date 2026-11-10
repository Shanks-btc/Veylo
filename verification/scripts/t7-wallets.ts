// Dev-only NEAR testnet accounts for T7. Usage: npx tsx scripts/t7-wallets.ts generate | generate-funder | check
// generate-funder writes a named-account key whose account the faucet service then creates. It prints the public key.
// Prints public account IDs and match results only. Never print a key from this file.
import dns from "node:dns";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";

// The network is blocked before the wallet library loads, so these imports stay dynamic.
let networkAttempts = 0;
const blocked = () => {
  networkAttempts++;
  throw new Error("Network access is blocked in t7-wallets.ts");
};
globalThis.fetch = blocked as typeof fetch;
net.Socket.prototype.connect = blocked as typeof net.Socket.prototype.connect;
dns.lookup = blocked as unknown as typeof dns.lookup;

const { KeyPair, keyToImplicitAddress } = await import("near-api-js");
const { parse } = await import("dotenv");

const ENV_URL = new URL("../.env", import.meta.url);
const TMP_URL = new URL("../.env.tmp", import.meta.url);
const ROLES = [
  { prefix: "AGENT_TESTNET", comment: "T7 agent payer" },
  { prefix: "SELLER_TESTNET", comment: "T7 seller" },
  { prefix: "FACILITATOR_RELAYER_TESTNET", comment: "T7 facilitator relayer" },
];
const allNames = ROLES.flatMap((r) => [`${r.prefix}_ACCOUNT_ID`, `${r.prefix}_SECRET_KEY`]);

function generate() {
  const before = readFileSync(ENV_URL, "utf8");
  const existing = parse(before);
  const occupied = allNames.filter((name) => existing[name]);
  if (occupied.length) throw new Error(`Refusing to overwrite: ${occupied.join(", ")}`);

  let text = before.split("\n").filter((line) => !allNames.some((name) => line.startsWith(`${name}=`))).join("\n").replace(/\n*$/, "\n");
  for (const role of ROLES) {
    const pair = KeyPair.fromRandom("ed25519");
    const accountId = keyToImplicitAddress(pair.getPublicKey());
    text += `# Dev-only ${role.comment} NEAR testnet implicit account ID (never for production).\n${role.prefix}_ACCOUNT_ID=${accountId}\n# Dev-only ${role.comment} NEAR testnet full-access private key (never for production).\n${role.prefix}_SECRET_KEY=${pair.toString()}\n`;
    console.log(`${role.prefix}: ${accountId}`);
  }
  const after = parse(text);
  for (const [name, value] of Object.entries(existing)) {
    if (!allNames.includes(name) && after[name] !== value) throw new Error("Another .env value would change");
  }
  writeFileSync(TMP_URL, text);
  renameSync(TMP_URL, ENV_URL);
}

function generateFunder() {
  const names = ["FUNDER_TESTNET_ACCOUNT_ID", "FUNDER_TESTNET_SECRET_KEY"];
  const before = readFileSync(ENV_URL, "utf8");
  const existing = parse(before);
  const occupied = names.filter((name) => existing[name]);
  if (occupied.length) throw new Error(`Refusing to overwrite: ${occupied.join(", ")}`);
  const pair = KeyPair.fromRandom("ed25519");
  const suffix = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");
  const accountId = `veylo-t7-funder-${suffix}.testnet`;
  const lines = [
    "# Dev-only T7 faucet-sponsored NEAR testnet account ID (never for production).",
    `FUNDER_TESTNET_ACCOUNT_ID=${accountId}`,
    "# Dev-only T7 funder testnet private key (never for production).",
    `FUNDER_TESTNET_SECRET_KEY=${pair.toString()}`,
    "",
  ];
  const text = before.replace(/\n*$/, "\n") + lines.join("\n");
  const after = parse(text);
  for (const [name, value] of Object.entries(existing)) {
    if (after[name] !== value) throw new Error("Another .env value would change");
  }
  writeFileSync(TMP_URL, text);
  renameSync(TMP_URL, ENV_URL);
  console.log(`FUNDER_TESTNET: ${accountId}`);
  console.log(`FUNDER_PUBLIC_KEY: ${pair.getPublicKey().toString()}`);
}

async function check() {
  const env = parse(readFileSync(ENV_URL, "utf8"));
  const { redact } = await import("../_util.js");
  for (const role of ROLES) {
    const id = env[`${role.prefix}_ACCOUNT_ID`];
    const secret = env[`${role.prefix}_SECRET_KEY`];
    const derived = keyToImplicitAddress(KeyPair.fromString(secret as Parameters<typeof KeyPair.fromString>[0]).getPublicKey());
    const out = JSON.stringify(redact({ note: `https://x.test/?a=${secret}&b=1` }));
    console.log(`${role.prefix}: ${derived === id ? "match" : "MISMATCH"}; 64 hex: ${/^[0-9a-f]{64}$/.test(id)}; redacted by value: ${!out.includes(secret) && out.includes("[REDACTED]")}`);
  }
}

const mode = process.argv[2];
try {
  if (mode === "generate") generate();
  else if (mode === "generate-funder") generateFunder();
  else if (mode === "check") await check();
  else throw new Error("Usage: t7-wallets.ts generate | generate-funder | check");
  console.log(`Network attempts: ${networkAttempts}`);
} catch (err) {
  const own = err instanceof Error && /^(Refusing|Usage|Another)/.test(err.message);
  console.log(`Failed: ${own ? (err as Error).message : err instanceof Error ? err.name : "unknown error"}`);
  console.log(`Network attempts: ${networkAttempts}`);
  process.exit(1);
}
