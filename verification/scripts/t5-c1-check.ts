// T5 step C1: offline check of near-api-js NEP-413 signing against the contract's own test vector.
// Uses no network and a throwaway random key. TREASURY_SECRET_KEY is not read by this script's logic.
// Run: npx tsx scripts/t5-c1-check.ts
import { baseEncode, KeyPair, KeyPairSigner, PublicKey } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { record } from "../_util.js";

// near/intents@32cd1f9788a347908164fbcc56525dc6542f158f, crates/signatures/nep413/src/lib.rs, verify_ok.
const VECTOR = {
  publicKeyHex: "e2e9cb7ac57cb46d4da1ce1d1cc2c33bdfe17407c517916b522724a8ea2c6c50",
  signatureHex: "e2ff6254871a3fec1853c167b42f0f14248c4cf7fef5452dc24d8dbdc5c4bf183ab707322b4d782d5f5a05571bae476c5f7ee41c473f3002e600865e46b75d0f",
  message: "Hello, world!",
  nonce: new Uint8Array(32),
  recipient: "intents.near",
};

// verifyMessage hashes with the library's serializer. Its only network use is this access-key lookup, stubbed here.
const offlineProvider = { viewAccessKey: async () => ({ permission: "FullAccess" }) } as unknown as Parameters<typeof verifyMessage>[0]["provider"];
async function verifies(publicKey: string, payload: { message: string; nonce: Uint8Array; recipient: string }, signature: Uint8Array) {
  try {
    await verifyMessage({ signerAccountId: "offline", signerPublicKey: publicKey, payload, signature, provider: offlineProvider });
    return true;
  } catch {
    return false;
  }
}

const vectorKey = "ed25519:" + baseEncode(Buffer.from(VECTOR.publicKeyHex, "hex"));
const vectorSignature = new Uint8Array(Buffer.from(VECTOR.signatureHex, "hex"));
const payload = { message: VECTOR.message, nonce: VECTOR.nonce, recipient: VECTOR.recipient };
const tampered = await verifies(vectorKey, { ...payload, message: "Hello, world?" }, vectorSignature);

const throwaway = KeyPair.fromRandom("ed25519");
const signed = await new KeyPairSigner(throwaway).signNep413Message("offline", payload);
const publicKey = signed.publicKey.toString();
const signature = "ed25519:" + baseEncode(signed.signature);

const checks = {
  contractVectorVerifies: await verifies(vectorKey, payload, vectorSignature),
  tamperedVectorRejected: !tampered,
  signatureIs64Bytes: signed.signature.length === 64,
  publicKeyIs32Bytes: PublicKey.from(publicKey).data.length === 32,
  publicKeyMatchesDocsPattern: /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(publicKey),
  signatureMatchesDocsPattern: /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(signature),
  librarySignatureVerifies: await verifies(publicKey, payload, signed.signature),
};
console.log(record("T5", "c1-signing-check", { ranAt: new Date().toISOString(), vectorSource: "near/intents@32cd1f9788a347908164fbcc56525dc6542f158f crates/signatures/nep413/src/lib.rs", checks }));
console.log(JSON.stringify(checks, null, 1));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
