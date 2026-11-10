// Spike S-C: offline check of recorded quote signatures with the official SDK. No network and no new quotes.
// The SDK is installed outside this workspace. Run: npx tsx scripts/s-c-verify.ts <folder containing node_modules>
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { record } from "../_util.js";

const sdkHome = process.argv[2];
if (!sdkHome) {
  console.log("Usage: s-c-verify.ts <folder containing node_modules>");
  process.exit(1);
}
const load = createRequire(`${sdkHome}/`);
const sdk = load("@defuse-protocol/one-click-sdk-typescript") as { verifyQuoteSignature(response: unknown, key?: string): boolean; quoteHash(response: unknown): string };
const version = (JSON.parse(readFileSync(`${sdkHome}/node_modules/@defuse-protocol/one-click-sdk-typescript/package.json`, "utf8")) as { version: string }).version;

const results = new URL("../results/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, results), "utf8"));
type Signed = { quote: Record<string, unknown>; quoteRequest: Record<string, unknown>; signature: string; timestamp: string };

const liveQuotes = ["T5-c2-quote", "T5-batch-quote-base", "T5-batch-quote-arb", "T5b-shield-quote", "T5b-payout-quote", "T5c-quote", "T5d-quote", "T5-fund-live-quote"];
const dryQuotes = ["T5-c0-dry-base", "T5b-payout-dry", "T5c-dry", "T5d-dry"];
const statusRecords = ["T5-c2-status", "T5b-payout-status", "T5c-status", "T5d-status"];

const untampered = [
  ...[...liveQuotes, ...dryQuotes].map((file) => ({ file, kind: liveQuotes.includes(file) ? "live quote" : "dry quote", valid: sdk.verifyQuoteSignature(read(file).response.body as Signed) })),
  ...statusRecords.map((file) => {
    const embedded = read(file).transitions.at(-1).response.body.quoteResponse as Signed;
    return { file, kind: "quoteResponse inside a status response", valid: sdk.verifyQuoteSignature(embedded) };
  }),
];

// Tampering: change one field at a time on a real live quote, keeping its genuine signature.
const base = read("T5-c2-quote").response.body as Signed;
const tamper = (label: string, change: (copy: Signed) => void) => {
  const copy = JSON.parse(JSON.stringify(base)) as Signed;
  change(copy);
  return { label, valid: sdk.verifyQuoteSignature(copy) };
};
const attacker = "a".repeat(64);
const tampered = [
  tamper("quote.depositAddress swapped", (c) => { c.quote.depositAddress = attacker; }),
  tamper("quoteRequest.recipient swapped", (c) => { c.quoteRequest.recipient = "0x000000000000000000000000000000000000dEaD"; }),
  tamper("quoteRequest.refundTo swapped", (c) => { c.quoteRequest.refundTo = attacker; }),
  tamper("quoteRequest.destinationAsset swapped", (c) => { c.quoteRequest.destinationAsset = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"; }),
  tamper("quote.amountOut lowered", (c) => { c.quote.amountOut = "1"; }),
  tamper("quote.amountIn raised", (c) => { c.quote.amountIn = "999999"; }),
  tamper("quoteRequest.appFees changed", (c) => { c.quoteRequest.appFees = [{ recipient: attacker, fee: 100, limitOrderId: null }]; }),
  tamper("quoteRequest.confidentiality changed", (c) => { c.quoteRequest.confidentiality = "advanced"; }),
  tamper("quoteRequest.insured changed", (c) => { c.quoteRequest.insured = true; }),
  tamper("quoteRequest.depositMode changed", (c) => { c.quoteRequest.depositMode = "MEMO"; }),
  tamper("quoteRequest.depositType changed", (c) => { c.quoteRequest.depositType = "CONFIDENTIAL_INTENTS"; }),
  tamper("quoteRequest.recipientType changed", (c) => { c.quoteRequest.recipientType = "INTENTS"; }),
  tamper("quote.minAmountIn changed", (c) => { c.quote.minAmountIn = "1"; }),
  tamper("quote.withdrawFee changed", (c) => { c.quote.withdrawFee = "1"; }),
  tamper("timestamp changed", (c) => { c.timestamp = "2026-11-05T15:27:39.000Z"; }),
  tamper("signature replaced by another quote's signature", (c) => { c.signature = (read("T5-batch-quote-base").response.body as Signed).signature; }),
];

// Does the intent the owner signed name the quote's deposit address, token and amount?
const pairs = [
  ["T5-c2-quote", "T5-c2-generate-intent"],
  ["T5-batch-quote-base", "T5-batch-generate-base"],
  ["T5-batch-quote-arb", "T5-batch-generate-arb"],
  ["T5b-shield-quote", "T5b-shield-generate"],
  ["T5b-payout-quote", "T5b-payout-generate"],
  ["T5c-quote", "T5c-generate"],
  ["T5d-quote", "T5d-generate"],
];
const binding = pairs.map(([quoteFile, intentFile]) => {
  const quoteBody = read(quoteFile).response.body as Signed;
  const intent = read(intentFile).response.body.intent as { payload: { message: string; recipient: string } };
  const message = JSON.parse(intent.payload.message) as { intents: { intent: string; receiver_id: string; tokens: Record<string, string> }[]; signer_id: string };
  const item = message.intents[0];
  const [token, amount] = Object.entries(item.tokens)[0];
  const raw = intent.payload.message.toLowerCase();
  const destination = String(quoteBody.quoteRequest.destinationAsset).toLowerCase();
  const recipient = String(quoteBody.quoteRequest.recipient).toLowerCase();
  return {
    intentFile,
    verifier: intent.payload.recipient,
    intentCount: message.intents.length,
    intentType: item.intent,
    receiverEqualsQuoteDepositAddress: item.receiver_id === quoteBody.quote.depositAddress,
    amountEqualsQuoteAmountIn: amount === quoteBody.quote.amountIn,
    tokenEndsWithOriginAsset: token.endsWith(String(quoteBody.quoteRequest.originAsset)),
    messageNamesFinalRecipient: raw.includes(recipient) && recipient !== String(message.signer_id).toLowerCase() && item.receiver_id.toLowerCase() !== recipient,
    messageNamesDestinationAsset: raw.includes(destination) && destination !== String(quoteBody.quoteRequest.originAsset).toLowerCase(),
  };
});

const output = { sdk: `@defuse-protocol/one-click-sdk-typescript@${version}`, untampered, tampered, binding };
console.log(record("S-C", "signature-check", output));
console.log(JSON.stringify(output, null, 1));
