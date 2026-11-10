import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  hashNep413,
  NEP413_TAG,
  parseEd25519PublicKey,
  serializeNep413,
  verifyNep413,
} from "./index.js";

// Recorded in verification/results/T5-c2-submit-intent.json: the dev treasury's signed intent.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/t5-c2-signed-payload.json", import.meta.url), "utf8"),
) as {
  message: string;
  nonce: string;
  recipient: string;
  publicKey: string;
  signature: string;
  signatureAsRecorded: string;
};

const valid = () => ({
  message: fixture.message,
  nonce: base64.decode(fixture.nonce),
  recipient: fixture.recipient,
  publicKey: fixture.publicKey,
  signature: fixture.signature,
});

const flipFirstByte = (bytes: Uint8Array) => {
  const out = Uint8Array.from(bytes);
  out[0] = (out[0] ?? 0) ^ 1;
  return out;
};

describe("recorded T5 signature", () => {
  it("verifies", () => {
    expect(verifyNep413(valid())).toBe(true);
  });

  it("the fixture's base64 signature is the recorded base58 one", () => {
    expect(base64.decode(fixture.signature)).toEqual(
      base58.decode(fixture.signatureAsRecorded.slice("ed25519:".length)),
    );
  });

  it("is the dev treasury's key: it derives the signer_id in the message", () => {
    const key = parseEd25519PublicKey(fixture.publicKey);
    const hex = Buffer.from(key as Uint8Array).toString("hex");
    expect(JSON.parse(fixture.message).signer_id).toBe(hex);
  });
});

describe("tampering fails", () => {
  it("message", () => {
    expect(verifyNep413({ ...valid(), message: `${fixture.message} ` })).toBe(false);
  });

  it("nonce", () => {
    expect(verifyNep413({ ...valid(), nonce: flipFirstByte(valid().nonce) })).toBe(false);
  });

  it("recipient", () => {
    expect(verifyNep413({ ...valid(), recipient: "intents.far" })).toBe(false);
  });

  it("public key", () => {
    const key = parseEd25519PublicKey(fixture.publicKey) as Uint8Array;
    const publicKey = `ed25519:${base58.encode(flipFirstByte(key))}`;
    expect(verifyNep413({ ...valid(), publicKey })).toBe(false);
  });

  it("signature", () => {
    const signature = base64.encode(flipFirstByte(base64.decode(fixture.signature)));
    expect(verifyNep413({ ...valid(), signature })).toBe(false);
  });
});

describe("malformed input returns false", () => {
  it.each([
    ["signature not base64", { signature: "not base64!" }],
    ["signature too short", { signature: base64.encode(new Uint8Array(63)) }],
    ["signature in the recorded base58 form", { signature: "ed25519:abc" }],
    ["key with no prefix", { publicKey: "CLfSXSJR9qqkHNPXmiPRuFqeyCh5eLtMYBj4ZbDTCBvD" }],
    ["key of the wrong curve", { publicKey: "secp256k1:abc" }],
    ["key too short", { publicKey: `ed25519:${base58.encode(new Uint8Array(31))}` }],
    ["nonce too short", { nonce: new Uint8Array(31) }],
  ])("%s", (_name, change) => {
    expect(verifyNep413({ ...valid(), ...change })).toBe(false);
  });
});

describe("serialization", () => {
  it("is tag, message, nonce, recipient, then a None byte", () => {
    const nonce = new Uint8Array(32).fill(7);
    const bytes = serializeNep413({ message: "hi", nonce, recipient: "a.near" });
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(NEP413_TAG);
    expect(NEP413_TAG).toBe(2 ** 31 + 413);
    expect(view.getUint32(4, true)).toBe(2);
    expect(new TextDecoder().decode(bytes.slice(8, 10))).toBe("hi");
    expect(bytes.slice(10, 42)).toEqual(nonce);
    expect(view.getUint32(42, true)).toBe(6);
    expect(new TextDecoder().decode(bytes.slice(46, 52))).toBe("a.near");
    expect(bytes[52]).toBe(0);
    expect(bytes.length).toBe(53);
  });

  it("counts message bytes, not characters", () => {
    const bytes = serializeNep413({ message: "é", nonce: new Uint8Array(32), recipient: "r" });
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(2);
  });

  it("refuses a nonce of the wrong size", () => {
    expect(() => hashNep413({ message: "", nonce: new Uint8Array(1), recipient: "" })).toThrow(
      RangeError,
    );
  });
});
