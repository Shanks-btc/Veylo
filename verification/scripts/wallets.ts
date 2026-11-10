// Dev-only wallets for verification. Usage: npx tsx scripts/wallets.ts generate | check
// Prints public addresses and match results only. Never print a key from this file.
import { createHash } from "node:crypto";
import dns from "node:dns";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";

// The network is blocked before any wallet library loads, so these imports stay dynamic.
let networkAttempts = 0;
const blocked = () => {
  networkAttempts++;
  throw new Error("Network access is blocked in wallets.ts");
};
globalThis.fetch = blocked as typeof fetch;
net.Socket.prototype.connect = blocked as typeof net.Socket.prototype.connect;
dns.lookup = blocked as unknown as typeof dns.lookup;

const { KeyPair, keyToImplicitAddress } = await import("near-api-js");
const { Keypair } = await import("@solana/web3.js");
const { getBase58Decoder, getBase58Encoder } = await import("@solana/kit");
const { Wallet } = await import("ethers");
const { TronWeb, utils: tronUtils } = await import("tronweb");
const { parse } = await import("dotenv");

const ENV_URL = new URL("../.env", import.meta.url);
const TMP_URL = new URL("../.env.tmp", import.meta.url);
const PROTECTED = ["ONECLICK_JWT", "NEARAI_API_KEY"];
const SECRET_COMMENTS: Record<string, [string, string]> = {
  CONTRACTOR_SOLANA_ADDRESS: ["CONTRACTOR_SOLANA_SECRET_KEY", "Dev-only Solana contractor private key, base58 (never for production)."],
  CONTRACTOR_EVM_ADDRESS: ["CONTRACTOR_EVM_SECRET_KEY", "Dev-only EVM contractor private key, 0x hex (never for production)."],
  CONTRACTOR_TRON_ADDRESS: ["CONTRACTOR_TRON_SECRET_KEY", "Dev-only Tron contractor private key, hex (never for production)."],
};

function fingerprint(env: Record<string, string>, name: string): string {
  return createHash("sha256").update(env[name] ?? "").digest("hex");
}

async function generate() {
  const before = readFileSync(ENV_URL, "utf8");
  const existing = parse(before);

  const near = KeyPair.fromRandom("ed25519");
  const solana = await Keypair.generate();
  const evm = Wallet.createRandom();
  const tron = tronUtils.accounts.generateAccount();

  const values: Record<string, string> = {
    TREASURY_ACCOUNT_ID: keyToImplicitAddress(near.getPublicKey()),
    TREASURY_SECRET_KEY: near.toString(),
    CONTRACTOR_SOLANA_ADDRESS: solana.address,
    CONTRACTOR_SOLANA_SECRET_KEY: getBase58Decoder().decode(solana.secretKey),
    CONTRACTOR_EVM_ADDRESS: evm.address,
    CONTRACTOR_EVM_SECRET_KEY: evm.privateKey,
    CONTRACTOR_TRON_ADDRESS: tron.address.base58,
    CONTRACTOR_TRON_SECRET_KEY: tron.privateKey,
  };

  const occupied = Object.keys(values).filter((name) => existing[name]);
  if (occupied.length) throw new Error(`Refusing to overwrite: ${occupied.join(", ")}`);

  let text = before;
  for (const [address, [secret, comment]] of Object.entries(SECRET_COMMENTS)) {
    if (new RegExp(`^${secret}=`, "m").test(text)) continue;
    text = text.replace(new RegExp(`^${address}=.*$`, "m"), (line) => `${line}\n# ${comment}\n${secret}=`);
  }
  for (const [name, value] of Object.entries(values)) {
    const line = new RegExp(`^${name}=.*$`, "m");
    if (!line.test(text)) throw new Error(`No line for ${name} in .env`);
    text = text.replace(line, () => `${name}=${value}`);
  }

  const after = parse(text);
  for (const name of PROTECTED) {
    if (fingerprint(existing, name) !== fingerprint(after, name)) throw new Error(`${name} would change`);
  }
  writeFileSync(TMP_URL, text);
  renameSync(TMP_URL, ENV_URL);

  console.log(`NEAR implicit: ${values.TREASURY_ACCOUNT_ID}`);
  console.log(`Solana:        ${values.CONTRACTOR_SOLANA_ADDRESS}`);
  console.log(`EVM:           ${values.CONTRACTOR_EVM_ADDRESS}`);
  console.log(`Tron:          ${values.CONTRACTOR_TRON_ADDRESS}`);
}

async function check() {
  const env = parse(readFileSync(ENV_URL, "utf8"));
  const line = (chain: string, derived: unknown, stored: string) =>
    console.log(`${chain}: ${derived === stored ? "match" : "MISMATCH"}`);

  const nearKey = env.TREASURY_SECRET_KEY as Parameters<typeof KeyPair.fromString>[0];
  const near = keyToImplicitAddress(KeyPair.fromString(nearKey).getPublicKey());
  line("NEAR", near, env.TREASURY_ACCOUNT_ID);
  console.log(`NEAR account ID is 64 lowercase hex: ${/^[0-9a-f]{64}$/.test(env.TREASURY_ACCOUNT_ID)}`);

  const solanaBytes = getBase58Encoder().encode(env.CONTRACTOR_SOLANA_SECRET_KEY);
  const solana = await Keypair.fromSecretKey(new Uint8Array(solanaBytes));
  line("Solana", solana.address, env.CONTRACTOR_SOLANA_ADDRESS);
  line("EVM", new Wallet(env.CONTRACTOR_EVM_SECRET_KEY).address, env.CONTRACTOR_EVM_ADDRESS);
  line("Tron", TronWeb.address.fromPrivateKey(env.CONTRACTOR_TRON_SECRET_KEY), env.CONTRACTOR_TRON_ADDRESS);

  // Loaded here so _util reads the .env this run just verified.
  const { redact } = await import("../_util.js");
  const secrets = Object.keys(env).filter((name) => name.endsWith("_SECRET_KEY") && env[name]);
  for (const name of secrets) {
    const out = JSON.stringify(redact({ note: `https://x.test/?a=${env[name]}&b=1` }));
    console.log(`${name} redacted by value: ${!out.includes(env[name]) && out.includes("[REDACTED]")}`);
  }

  for (const name of PROTECTED) console.log(`${name} still set: ${Boolean(env[name])}`);
}

const mode = process.argv[2];
try {
  if (mode === "generate") await generate();
  else if (mode === "check") await check();
  else throw new Error("Usage: wallets.ts generate | check");
  console.log(`Network attempts: ${networkAttempts}`);
} catch (err) {
  // Library errors can quote their input, so only our own messages are shown in full.
  const own = err instanceof Error && /^(Refusing|No line|Usage|[A-Z_]+ would change)/.test(err.message);
  console.log(`Failed: ${own ? (err as Error).message : err instanceof Error ? err.name : "unknown error"}`);
  console.log(`Network attempts: ${networkAttempts}`);
  process.exit(1);
}
