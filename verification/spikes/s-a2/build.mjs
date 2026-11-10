// Throwaway. Extracts the two recorded payloads and the official Meteor manifest entry, then bundles the page.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = (name) => new URL(name, import.meta.url);
const results = new URL("../../results/", import.meta.url);
const intent = (file) => JSON.parse(readFileSync(new URL(`${file}.json`, results), "utf8")).response.body.intent;
const payloads = [
  { label: "T5 C2 (public)", file: "T5-c2-generate-intent" },
  { label: "T5b payout (confidential)", file: "T5b-payout-generate" },
].map(({ label, file }) => {
  const i = intent(file);
  if (Object.keys(i.payload).sort().join() !== "message,nonce,recipient") throw new Error(`Unexpected payload in ${file}`);
  return { label, sourceFile: file, ...i.payload };
});
writeFileSync(here("./payloads.json"), JSON.stringify(payloads, null, 2));

const res = await fetch("https://raw.githubusercontent.com/azbang/near-connect/main/repository/manifest.json");
const official = await res.json();
const meteor = official.wallets.find((w) => w.id === "meteor-wallet");
if (!meteor) throw new Error("Meteor is missing from the official manifest");
writeFileSync(here("./manifest.meteor.json"), JSON.stringify({ version: official.version, wallets: [meteor] }, null, 2));

const executor = Buffer.from(await (await fetch(meteor.executor)).arrayBuffer());
const facts = {
  fetchedAt: new Date().toISOString(),
  manifestSource: res.url,
  manifestVersion: official.version,
  meteorVersion: meteor.version,
  executor: meteor.executor,
  executorSha256: createHash("sha256").update(executor).digest("hex"),
  executorBytes: executor.length,
  permissions: meteor.permissions,
};
writeFileSync(here("./build-facts.json"), JSON.stringify(facts, null, 2));

mkdirSync(here("./dist/"), { recursive: true });
copyFileSync(here("./index.html"), here("./dist/index.html"));
await build({
  entryPoints: [fileURLToPath(here("./page.ts"))],
  bundle: true,
  format: "esm",
  target: "es2020",
  platform: "browser",
  outfile: fileURLToPath(here("./dist/page.js")),
  logLevel: "warning",
  define: { global: "globalThis" },
});
console.log(JSON.stringify(facts, null, 1));
