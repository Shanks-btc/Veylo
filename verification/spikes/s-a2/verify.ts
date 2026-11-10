// Throwaway. S-A2 offline checks on real Meteor output. No network, nothing submitted.
// Keeps the founder's account ID, public key and signature out of the recorded evidence.
// Run from verification/: npx tsx spikes/s-a2/verify.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { baseEncode, PublicKey } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import { record } from "../../_util.js";

const local = (name: string) => new URL(name, import.meta.url);
const input = JSON.parse(readFileSync(local("./signed-output.json"), "utf8")) as {
  userAgent: string;
  connector: string;
  requestsVisibleToPage: string[];
  connectedAccounts: Record<string, unknown>[];
  results: { label: string; verifierRequested: string; ok: boolean; at: string; rawOutput?: Record<string, unknown>; outputTypes?: Record<string, string>; error?: string }[];
};
const payloads = JSON.parse(readFileSync(local("./payloads.json"), "utf8")) as { label: string; sourceFile: string; message: string; nonce: string; recipient: string }[];

const offlineProvider = { viewAccessKey: async () => ({ permission: "FullAccess" }) } as unknown as Parameters<typeof verifyMessage>[0]["provider"];
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const EXPECTED_KEYS = ["accountId", "publicKey", "signature"];

// The hash, built by hand from NEP-413, as a check independent of near-api-js.
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
const verifies = async (publicKey: string, signature: Uint8Array, payload: { message: string; recipient: string; nonce: Uint8Array; callbackUrl?: string }) => {
  try {
    await verifyMessage({ signerAccountId: "offline", signerPublicKey: publicKey, signature, payload, provider: offlineProvider });
    return true;
  } catch {
    return false;
  }
};

// The S-A mapping, unchanged in its checks.
async function toSignedData(payload: { message: string; nonce: string; recipient: string }, output: Record<string, unknown>, expectedSigner: string) {
  if (output.accountId !== expectedSigner) throw new Error("accountId is not the expected signer");
  if (typeof output.publicKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(output.publicKey)) throw new Error("publicKey is not ed25519:<base58>");
  if (typeof output.signature !== "string" || !STRICT_BASE64.test(output.signature)) throw new Error("signature is not a base64 string");
  const bytes = Buffer.from(output.signature, "base64");
  if (bytes.length !== 64) throw new Error(`signature decodes to ${bytes.length} bytes, expected 64`);
  const ok = await verifies(output.publicKey, new Uint8Array(bytes), { message: payload.message, recipient: payload.recipient, nonce: new Uint8Array(Buffer.from(payload.nonce, "base64")) });
  if (!ok) throw new Error("signature does not verify over the unmodified payload");
  return { standard: "nep413", payload: { message: payload.message, nonce: payload.nonce, recipient: payload.recipient }, public_key: output.publicKey, signature: "ed25519:" + baseEncode(new Uint8Array(bytes)) };
}

const perPayload = [];
for (const payload of payloads) {
  const result = input.results.find((r) => r.label === payload.label);
  if (!result) {
    perPayload.push({ label: payload.label, recipient: payload.recipient, outcome: "NO RESULT: no entry in the output, so it was not attempted or did not return" });
    continue;
  }
  if (!result.ok || !result.rawOutput) {
    perPayload.push({ label: payload.label, recipient: payload.recipient, outcome: "WALLET ERROR", error: result.error });
    continue;
  }
  const output = result.rawOutput;
  const publicKey = output.publicKey as string;
  const signatureBytes = new Uint8Array(Buffer.from(output.signature as string, "base64"));
  const nonce = new Uint8Array(Buffer.from(payload.nonce, "base64"));
  const params = { message: payload.message, recipient: payload.recipient, nonce };

  const signer = JSON.parse(payload.message).signer_id as string;
  const attempt = async (expected: string) => {
    try {
      const mapped = await toSignedData(payload, output, expected);
      return { accepted: true, mappedFields: Object.keys(mapped), signatureFormatOk: /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(mapped.signature), payloadUnmodified: mapped.payload.message === payload.message && mapped.payload.nonce === payload.nonce && mapped.payload.recipient === payload.recipient };
    } catch (err) {
      return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };

  perPayload.push({
    label: payload.label,
    recipient: payload.recipient,
    outcome: "SIGNED",
    outputShape: {
      keys: Object.keys(output),
      types: result.outputTypes,
      extraFields: Object.keys(output).filter((k) => !EXPECTED_KEYS.includes(k)),
      hasCallbackUrl: "callbackUrl" in output,
      hasState: "state" in output,
      signatureEncoding: STRICT_BASE64.test(output.signature as string) ? "base64" : "not base64",
      signatureBytes: signatureBytes.length,
      publicKeyFormat: /^ed25519:/.test(publicKey) ? "ed25519:<base58>" : "other",
      accountIdMatchesConnectedAccount: output.accountId === input.connectedAccounts[0]?.accountId,
    },
    mapping: await attempt(output.accountId as string),
    mappingAgainstPayloadSignerId: await attempt(signer),
    verification: {
      c1Method: await verifies(publicKey, signatureBytes, params),
      independentHandBuiltHash: PublicKey.fromString(publicKey).verify(nep413Hash(params), signatureBytes),
    },
    controls: {
      "wrong recipient rejected": !(await verifies(publicKey, signatureBytes, { ...params, recipient: payload.recipient === "intents.near" ? "intents.far" : "intents.near" })),
      "changed message rejected": !(await verifies(publicKey, signatureBytes, { ...params, message: payload.message + " " })),
      "changed nonce rejected": !(await verifies(publicKey, signatureBytes, { ...params, nonce: new Uint8Array(32) })),
      "extra callbackUrl rejected, so none was hashed": !(await verifies(publicKey, signatureBytes, { ...params, callbackUrl: "http://localhost:4173" })),
      "tampered signature rejected": !(await verifies(publicKey, Uint8Array.from(signatureBytes, (b, i) => (i === 0 ? b ^ 1 : b)), params)),
    },
    accountType: /^[0-9a-f]{64}$/.test(output.accountId as string) ? "implicit" : "named",
  });
}

const evidence = {
  note: "Real Meteor output. The founder's account ID, public key and signature are deliberately not recorded here. Nothing was submitted.",
  connector: input.connector,
  browser: input.userAgent,
  connectedAccountFields: Object.keys(input.connectedAccounts[0] ?? {}),
  requestsVisibleToPage: input.requestsVisibleToPage.map((u) => u.split("?")[0]),
  perPayload,
};
console.log(record("S-A2", "offline-checks", evidence));
console.log(JSON.stringify(evidence, null, 1));
