// Spike S-A: offline checks of a wallet-shaped NEP-413 output against 1Click's signedData, and of payee records.
// No network, no submission, no funds. Keys are read from .env and never printed or recorded.
// Run: npx tsx scripts/s-a-offline.ts
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { baseEncode, KeyPair, keyToImplicitAddress, PublicKey } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { record } from "../_util.js";

const results = new URL("../results/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, results), "utf8"));
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

// ---- NEP-413 hash, built by hand from the spec so it is independent of near-api-js ----
function borshString(value: string) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}
function nep413Hash(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string }) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2147484061);
  const callback = p.callbackUrl ? Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]) : Buffer.from([0]);
  return createHash("sha256").update(Buffer.concat([tag, borshString(p.message), Buffer.from(p.nonce), borshString(p.recipient), callback])).digest();
}

type WalletParams = { message: string; recipient: string; nonce: Uint8Array; callbackUrl?: string; state?: string };
type WalletOutput = { accountId: string; publicKey: unknown; signature: unknown; state?: string };

// A simulated wallet. It follows the NEP-413 output interface: base64 signature, "<type>:<base58>" public key.
function simulateWallet(params: WalletParams, accountId: string, key: KeyPair): WalletOutput {
  if (params.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const { signature } = key.sign(nep413Hash(params));
  return { accountId, publicKey: key.getPublicKey().toString(), signature: Buffer.from(signature).toString("base64"), ...(params.state ? { state: params.state } : {}) };
}

// ---- The mapping under test ----
type Intent = { standard: string; payload: Record<string, string> };
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const offlineProvider = { viewAccessKey: async () => ({ permission: "FullAccess" }) } as unknown as Parameters<typeof verifyMessage>[0]["provider"];

async function toSignedData(intent: Intent, output: WalletOutput, expectedSigner: string) {
  if (intent.standard !== "nep413") throw new Error("standard is not nep413");
  if (output.accountId !== expectedSigner) throw new Error("accountId is not the expected signer");
  if (typeof output.publicKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(output.publicKey)) throw new Error("publicKey is not ed25519:<base58>");
  if (typeof output.signature !== "string" || !STRICT_BASE64.test(output.signature)) throw new Error("signature is not a base64 string");
  const signatureBytes = Buffer.from(output.signature, "base64");
  if (signatureBytes.length !== 64) throw new Error(`signature decodes to ${signatureBytes.length} bytes, expected 64`);
  const nonce = Buffer.from(intent.payload.nonce, "base64");
  try {
    await verifyMessage({
      signerAccountId: expectedSigner,
      signerPublicKey: output.publicKey,
      signature: new Uint8Array(signatureBytes),
      payload: { message: intent.payload.message, recipient: intent.payload.recipient, nonce: new Uint8Array(nonce), ...(intent.payload.callbackUrl ? { callbackUrl: intent.payload.callbackUrl } : {}) },
      provider: offlineProvider,
    });
  } catch {
    throw new Error("signature does not verify over the unmodified payload");
  }
  return { ...intent, public_key: output.publicKey, signature: "ed25519:" + baseEncode(new Uint8Array(signatureBytes)) };
}
const paramsFrom = (intent: Intent, extra: Partial<WalletParams> = {}): WalletParams => ({
  message: intent.payload.message,
  recipient: intent.payload.recipient,
  nonce: Buffer.from(intent.payload.nonce, "base64"), // Bytes for the wallet. The payload keeps the base64 string.
  ...extra,
});
const outcome = async (run: () => Promise<unknown> | unknown) => {
  try {
    await run();
    return { accepted: true };
  } catch (err) {
    return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
  }
};

const treasuryId = required("TREASURY_ACCOUNT_ID");
const treasuryKey = KeyPair.fromString(required("TREASURY_SECRET_KEY") as KeyPairString);
const recipientId = required("RECIPIENT_NEAR_ACCOUNT_ID");
const recipientKey = KeyPair.fromString(required("RECIPIENT_NEAR_SECRET_KEY") as KeyPairString);

// ---- Step 4: reproduce what 1Click accepted in live runs ----
const vectors = [
  { generate: "T5-c2-generate-intent", submit: "T5-c2-submit-intent", signer: treasuryId, key: treasuryKey },
  { generate: "T5-batch-generate-base", submit: "T5-batch-submit-base", signer: treasuryId, key: treasuryKey },
  { generate: "T5-batch-generate-arb", submit: "T5-batch-submit-arb", signer: treasuryId, key: treasuryKey },
  { generate: "T5b-shield-generate", submit: "T5b-shield-submit", signer: treasuryId, key: treasuryKey },
  { generate: "T5b-payout-generate", submit: "T5b-payout-submit", signer: treasuryId, key: treasuryKey },
  { generate: "T5c-generate", submit: "T5c-submit", signer: treasuryId, key: treasuryKey },
  { generate: "T5d-generate", submit: "T5d-submit", signer: recipientId, key: recipientKey },
];
const reproduced = [];
for (const v of vectors) {
  const intent = read(v.generate).response.body.intent as Intent;
  const submitted = read(v.submit);
  const live = submitted.request.body.signedData as { standard: string; payload: unknown; public_key: string; signature: string };
  const output = simulateWallet(paramsFrom(intent), v.signer, v.key);
  const mapped = await toSignedData(intent, output, v.signer);
  reproduced.push({
    generate: v.generate,
    verifier: intent.payload.recipient,
    walletSignatureIsBase64: typeof output.signature === "string" && STRICT_BASE64.test(output.signature),
    standardMatches: mapped.standard === live.standard,
    payloadMatches: JSON.stringify(mapped.payload) === JSON.stringify(live.payload),
    publicKeyMatches: mapped.public_key === live.public_key,
    signatureMatchesLiveByteForByte: mapped.signature === live.signature,
    acceptedLiveWithHttp: submitted.response.status,
  });
}

// The docs' own wallet-return example, checked with the same base64 conversion.
const challenge = Buffer.from(Array.from(Array(32).keys()));
const docsExample = {
  source: "https://docs.near.org/web3-apps/backend/backend.md",
  ...(await outcome(() =>
    verifyMessage({
      signerAccountId: "maguila.testnet",
      signerPublicKey: "ed25519:AtH7GEjv2qmBVoT8qoRhWXizXM5CC12DC6tiqY9iNoRm",
      signature: new Uint8Array(Buffer.from("IfModLa3g3czlyPhkg/LSkTFSy7XCGreStZJTDIO1m3viEnYFLdXfpz1gYUVKYv3W2vwcV77TmGEzc9y0Nz+AA==", "base64")),
      payload: { message: "log me in", recipient: "http://localhost:3000", nonce: new Uint8Array(challenge) },
      provider: offlineProvider,
    }),
  )),
};

// ---- What a wallet may add or change ----
const c2 = read("T5-c2-generate-intent").response.body.intent as Intent;
const good = simulateWallet(paramsFrom(c2), treasuryId, treasuryKey);
const goodBytes = Buffer.from(good.signature as string, "base64");
const withCallback = simulateWallet(paramsFrom(c2, { callbackUrl: "https://veylo.example/callback" }), treasuryId, treasuryKey);
const otherKey = KeyPair.fromRandom("ed25519");
const walletDeviations = {
  "wallet hashes a callbackUrl the payload lacks (MyNearWallet passes one by default)": await outcome(() => toSignedData(c2, withCallback, treasuryId)),
  "the same signature, with callbackUrl added to the payload": await outcome(() => toSignedData({ ...c2, payload: { ...c2.payload, callbackUrl: "https://veylo.example/callback" } }, withCallback, treasuryId)),
  "wallet returns a state field, not part of the hash": await outcome(() => toSignedData(c2, simulateWallet(paramsFrom(c2, { state: "abc" }), treasuryId, treasuryKey), treasuryId)),
  "wallet signs for a different recipient": await outcome(() => toSignedData(c2, simulateWallet(paramsFrom(c2, { recipient: "myapp.com" }), treasuryId, treasuryKey), treasuryId)),
  "wallet changes the message": await outcome(() => toSignedData(c2, simulateWallet(paramsFrom(c2, { message: c2.payload.message + " " }), treasuryId, treasuryKey), treasuryId)),
  "wallet is given a re-generated nonce": await outcome(() => toSignedData(c2, simulateWallet(paramsFrom(c2, { nonce: randomBytes(32) }), treasuryId, treasuryKey), treasuryId)),
  "base64 nonce string passed as text, not decoded": await outcome(() => toSignedData(c2, simulateWallet(paramsFrom(c2, { nonce: Buffer.from(c2.payload.nonce, "utf8") }), treasuryId, treasuryKey), treasuryId)),
  "signature returned as raw bytes (near-api-js SignedMessage shape)": await outcome(() => toSignedData(c2, { ...good, signature: new Uint8Array(goodBytes) }, treasuryId)),
  "public key returned as an object (near-api-js SignedMessage shape)": await outcome(() => toSignedData(c2, { ...good, publicKey: treasuryKey.getPublicKey() }, treasuryId)),
  "signature returned as base58": await outcome(() => toSignedData(c2, { ...good, signature: baseEncode(new Uint8Array(goodBytes)) }, treasuryId)),
  "signature returned as ed25519:base58": await outcome(() => toSignedData(c2, { ...good, signature: "ed25519:" + baseEncode(new Uint8Array(goodBytes)) }, treasuryId)),
  "signature returned as hex": await outcome(() => toSignedData(c2, { ...good, signature: goodBytes.toString("hex") }, treasuryId)),
  "signature from a different key": await outcome(() => toSignedData(c2, { ...simulateWallet(paramsFrom(c2), treasuryId, otherKey), publicKey: good.publicKey }, treasuryId)),
  "different account selected in the wallet": await outcome(() => toSignedData(c2, simulateWallet(paramsFrom(c2), recipientId, recipientKey), treasuryId)),
  "valid signature from an unexpected key, with its own public key returned": await outcome(() => toSignedData(c2, simulateWallet(paramsFrom(c2), treasuryId, otherKey), treasuryId)),
};

// ---- Step 5: payee records ----
const PAYEE_RECIPIENT: string = "veylo.payee-registry"; // Domain separation: cannot equal intents.near or intents.far.
const PAYEE_FIELDS = ["org", "contractor_id", "chain", "destination_asset", "recipient", "recipient_type", "version", "approved_at"].sort();
const canonical = (o: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));

const ownerId = required("AGENT_TESTNET_ACCOUNT_ID"); // A testnet key, so no mainnet key signs a registry test record.
const ownerKey = KeyPair.fromString(required("AGENT_TESTNET_SECRET_KEY") as KeyPairString);
const payee = {
  org: "org_demo",
  contractor_id: "contractor_001",
  chain: "base",
  destination_asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  recipient: "0x000000000000000000000000000000000000dEaD",
  recipient_type: "DESTINATION_CHAIN",
  version: 3,
  approved_at: "2026-11-06T10:00:00.000Z",
};
const payeeNonce = randomBytes(32);
const payeeMessage = canonical(payee);
const payeeOutput = simulateWallet({ message: payeeMessage, recipient: PAYEE_RECIPIENT, nonce: payeeNonce }, ownerId, ownerKey);

// The owner's key comes from the chain, never from the backend. Fixtures follow the query view_access_key_list shape.
type KeyListEntry = { public_key: string; access_key: { nonce: number; permission: string | { FunctionCall: unknown } } };
const fullAccessKeys = (keys: KeyListEntry[]) => keys.filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key);
const deriveImplicit = (accountId: string) => {
  if (!/^[0-9a-f]{64}$/.test(accountId)) throw new Error("not an implicit account ID");
  return "ed25519:" + baseEncode(new Uint8Array(Buffer.from(accountId, "hex")));
};
function ownerKeys(accountId: string, rpc: { keys: KeyListEntry[] } | { unknownAccount: true }) {
  if ("keys" in rpc) return fullAccessKeys(rpc.keys); // The chain's list is authoritative once the account exists.
  return [deriveImplicit(accountId)]; // Never-funded implicit account: only its derived key can exist.
}

type SignedRecord = { message: string; nonce: string; recipient: string; publicKey: string; signature: string; accountId: string };
function verifyPayee(r: SignedRecord, owner: string, allowedKeys: string[], minVersion = 0) {
  if (r.recipient !== PAYEE_RECIPIENT) throw new Error("wrong recipient: not a payee record");
  if (r.accountId !== owner) throw new Error("signed by another account");
  if (!allowedKeys.includes(r.publicKey)) throw new Error("public key is not a full-access key of the owner");
  const nonce = Buffer.from(r.nonce, "base64");
  if (nonce.length !== 32) throw new Error("nonce is not 32 bytes");
  const sig = Buffer.from(r.signature, "base64");
  if (sig.length !== 64) throw new Error("signature is not 64 bytes");
  const ok = PublicKey.fromString(r.publicKey).verify(nep413Hash({ message: r.message, nonce, recipient: r.recipient }), new Uint8Array(sig));
  if (!ok) throw new Error("signature does not verify");
  const fields = JSON.parse(r.message) as Record<string, unknown>;
  if (Object.keys(fields).sort().join() !== PAYEE_FIELDS.join()) throw new Error("unexpected fields");
  if (canonical(fields) !== r.message) throw new Error("message is not canonical");
  if ((fields.version as number) < minVersion) throw new Error(`version ${fields.version} is older than ${minVersion}`);
  return fields;
}

const signedRecord: SignedRecord = { message: payeeMessage, nonce: payeeNonce.toString("base64"), recipient: PAYEE_RECIPIENT, publicKey: payeeOutput.publicKey as string, signature: payeeOutput.signature as string, accountId: ownerId };
const ownerPublic = ownerKey.getPublicKey().toString();
const fcOnly: KeyListEntry[] = [{ public_key: ownerPublic, access_key: { nonce: 1, permission: { FunctionCall: { allowance: "0", receiver_id: "x.near", method_names: [] } } } }];
const full: KeyListEntry[] = [{ public_key: ownerPublic, access_key: { nonce: 1, permission: "FullAccess" } }];
const otherFull: KeyListEntry[] = [{ public_key: otherKey.getPublicKey().toString(), access_key: { nonce: 1, permission: "FullAccess" } }];
const unknown = { unknownAccount: true as const };

const tamperedField = (field: string, value: unknown) => {
  const changed = { ...payee, [field]: value };
  return outcome(() => verifyPayee({ ...signedRecord, message: canonical(changed) }, ownerId, ownerKeys(ownerId, unknown)));
};
const oldOutput = simulateWallet({ message: canonical({ ...payee, version: 2, recipient: "0x1111111111111111111111111111111111111111" }), recipient: PAYEE_RECIPIENT, nonce: payeeNonce }, ownerId, ownerKey);
const oldRecord = { ...signedRecord, message: canonical({ ...payee, version: 2, recipient: "0x1111111111111111111111111111111111111111" }), signature: oldOutput.signature as string };

// Can a record's signature be used as an intent, or an intent's as a record?
const parsedAsIntent = JSON.parse(payeeMessage) as Record<string, unknown>;
const c2Output = simulateWallet(paramsFrom(c2), treasuryId, treasuryKey);

const payeeChecks = {
  valid: {
    "implicit account, never funded: key derived from the account ID": await outcome(() => verifyPayee(signedRecord, ownerId, ownerKeys(ownerId, unknown))),
    "key listed as FullAccess by view_access_key_list": await outcome(() => verifyPayee(signedRecord, ownerId, ownerKeys(ownerId, { keys: full }))),
    "derived key matches the wallet's key": deriveImplicit(ownerId) === ownerPublic && keyToImplicitAddress(ownerPublic) === ownerId,
  },
  tamperedFields: {
    org: await tamperedField("org", "org_other"),
    contractor_id: await tamperedField("contractor_id", "contractor_999"),
    chain: await tamperedField("chain", "arb"),
    destination_asset: await tamperedField("destination_asset", "nep141:other"),
    recipient: await tamperedField("recipient", "0x2222222222222222222222222222222222222222"),
    recipient_type: await tamperedField("recipient_type", "INTENTS"),
    version: await tamperedField("version", 4),
    approved_at: await tamperedField("approved_at", "2030-01-01T00:00:00.000Z"),
  },
  otherFailures: {
    "public key only has FunctionCall permission": await outcome(() => verifyPayee(signedRecord, ownerId, ownerKeys(ownerId, { keys: fcOnly }))),
    "public key not in the owner's list (for example, removed later)": await outcome(() => verifyPayee(signedRecord, ownerId, ownerKeys(ownerId, { keys: otherFull }))),
    "record signed for a different recipient": await outcome(() => verifyPayee({ ...signedRecord, recipient: "intents.near" }, ownerId, ownerKeys(ownerId, unknown))),
    "claimed to be another owner's record": await outcome(() => verifyPayee(signedRecord, recipientId, ownerKeys(recipientId, unknown))),
    "valid older version, with no minimum version known": await outcome(() => verifyPayee(oldRecord, ownerId, ownerKeys(ownerId, unknown))),
    "valid older version, with minimum version 3": await outcome(() => verifyPayee(oldRecord, ownerId, ownerKeys(ownerId, unknown), 3)),
  },
  separationFromIntents: {
    payeeRecipientIsNotAVerifier: PAYEE_RECIPIENT !== "intents.near" && PAYEE_RECIPIENT !== "intents.far",
    recordMessageHasSignerId: "signer_id" in parsedAsIntent,
    recordMessageHasDeadline: "deadline" in parsedAsIntent,
    recordMessageHasIntents: "intents" in parsedAsIntent,
    "intent signature presented as a payee record": await outcome(() => verifyPayee({ message: c2.payload.message, nonce: c2.payload.nonce, recipient: PAYEE_RECIPIENT, publicKey: c2Output.publicKey as string, signature: c2Output.signature as string, accountId: treasuryId }, treasuryId, [c2Output.publicKey as string])),
  },
};

const output = {
  note: "Simulated wallet output. No real wallet, browser or network was used.",
  reproduced,
  docsExample,
  walletDeviations,
  payeeRecordExample: { recordFields: payee, signingRecipient: PAYEE_RECIPIENT, canonicalMessage: payeeMessage, walletOutputShape: { accountId: payeeOutput.accountId, publicKey: payeeOutput.publicKey, signatureEncoding: "base64, 64 bytes" } },
  payeeChecks,
};
console.log(record("S-A", "offline-checks", output));
console.log(JSON.stringify({ reproduced, docsExample, walletDeviations, payeeChecks }, null, 1));
