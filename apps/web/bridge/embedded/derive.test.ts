// The wallet's key derivation: SLIP-0010 ed25519 test vectors, and a real vector from the NEAR
// docs (near-cli's credentials example) proving the same recovery phrase gives the same account in
// other NEAR tools.
import { base58 } from "@scure/base";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  entropyFromPhrase,
  isValidPhrase,
  keyFromEntropy,
  keyFromPhrase,
  newPhrase,
  phraseFromEntropy,
  slip10Ed25519,
  splitPhrase,
} from "./derive";

describe("SLIP-0010 ed25519 (the spec's test vector 1)", () => {
  const seed = hexToBytes("000102030405060708090a0b0c0d0e0f");
  it.each([
    [[], "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7"],
    [[0], "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3"],
    [[0, 1], "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2"],
    [[0, 1, 2], "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9"],
  ])("m/%j", (path, expected) => {
    expect(bytesToHex(slip10Ed25519(seed, path as number[]))).toBe(expected);
  });
});

describe("the recovery phrase and the account", () => {
  // From docs.near.org "Creating Implicit & Named Accounts" (near-cli credentials, path m/44'/397'/0').
  const DOC = {
    phrase: "kit creek invite deputy fetch resource marble sweet camp thumb mushroom swift",
    account: "cf4342372b583606057805490c97d4778bc4ac444a76f32154634558ab57c3c5",
    publicKey: "ed25519:Ex4stLtTe43ynFmxGweGzMWLvRmRSUP6EjU6nvAdY2vg",
    privateKey:
      "ed25519:5uJtH8hdYKPEhLVTn9EoxaneLpKh11qLEWDVvG6tKTeMUzsmf7isHYxXixhNcupRhUNQ2fHFgtKXy94YUXHfbxiG",
  };

  it("derives exactly the account and keys near-cli shows for the same phrase", () => {
    const key = keyFromPhrase(DOC.phrase);
    expect(key.accountId).toBe(DOC.account);
    expect(key.publicKey).toBe(DOC.publicKey);
    // near-cli's private key is the 32-byte seed followed by the 32-byte public key.
    const full = new Uint8Array([...key.secret, ...key.publicBytes]);
    expect(`ed25519:${base58.encode(full)}`).toBe(DOC.privateKey);
  });

  it("the account is the public key as 64 hex characters", () => {
    const key = keyFromPhrase(newPhrase(12));
    expect(key.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(key.accountId).toBe(bytesToHex(key.publicBytes));
  });

  it("makes 12-word and 24-word phrases, all valid and different each time", () => {
    const a = newPhrase(12);
    const b = newPhrase(12);
    expect(splitPhrase(a)).toHaveLength(12);
    expect(splitPhrase(newPhrase(24))).toHaveLength(24);
    expect(isValidPhrase(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("refuses a phrase that isn't valid, and ignores case and extra spaces", () => {
    expect(isValidPhrase("hello world")).toBe(false);
    expect(() => keyFromPhrase("not a real phrase at all")).toThrow(/valid recovery phrase/);
    expect(keyFromPhrase(`  ${DOC.phrase.toUpperCase()}  `).accountId).toBe(DOC.account);
  });

  it("entropy round-trips to the same phrase and the same key", () => {
    const phrase = newPhrase(12);
    const entropy = entropyFromPhrase(phrase);
    expect(entropy).toHaveLength(16);
    expect(phraseFromEntropy(entropy)).toBe(phrase);
    expect(keyFromEntropy(entropy).accountId).toBe(keyFromPhrase(phrase).accountId);
  });
});
