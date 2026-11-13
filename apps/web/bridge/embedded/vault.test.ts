// The vault: what is stored is only ciphertext, a wrong password or passkey output fails, and any
// change to the stored bytes (or to the account they claim to be for) makes decryption fail.
import { randomBytes } from "node:crypto";
import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { entropyFromPhrase, keyFromEntropy, newPhrase, phraseFromEntropy } from "./derive";
import {
  KDF_PARAMS,
  isVaultBlob,
  newVault,
  unlockWithPasskey,
  unlockWithPassword,
  wrapWithPasskey,
  wrapWithPassword,
  type PasskeyWrap,
  type PasswordWrap,
} from "./vault";

const random = (n: number) => new Uint8Array(randomBytes(n));
// A cheap Argon2id cost for the many tests; one test checks the real cost.
const CHEAP = { t: 1, m: 8, p: 1 };
const entropy = entropyFromPhrase(newPhrase(12));
const PASSWORD = "correct horse battery staple 7";
const flip = (text: string) => {
  const bytes = base64.decode(text);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return base64.encode(bytes);
};

describe("password protection", () => {
  it("unlocks with the right password and returns the same entropy and key", async () => {
    const wrap = await wrapWithPassword(entropy, PASSWORD, random, CHEAP);
    const blob = newVault(entropy, wrap);
    const got = await unlockWithPassword(blob, wrap, PASSWORD);
    expect(phraseFromEntropy(got)).toBe(phraseFromEntropy(entropy));
    expect(keyFromEntropy(got).accountId).toBe(blob.accountId);
  });

  it("a wrong password fails", async () => {
    const wrap = await wrapWithPassword(entropy, PASSWORD, random, CHEAP);
    const blob = newVault(entropy, wrap);
    await expect(unlockWithPassword(blob, wrap, "Correct horse battery staple 7")).rejects.toThrow(
      /did not unlock/,
    );
  });

  it("stores only ciphertext: neither the entropy, the phrase nor the password appear", async () => {
    const wrap = await wrapWithPassword(entropy, PASSWORD, random, CHEAP);
    const stored = JSON.stringify(newVault(entropy, wrap));
    expect(stored).not.toContain(PASSWORD);
    for (const word of phraseFromEntropy(entropy).split(" "))
      expect(stored).not.toContain(`"${word}"`);
    expect(stored).not.toContain(Buffer.from(entropy).toString("hex"));
    expect(stored).not.toContain(base64.encode(entropy));
  });

  it("a tampered ciphertext, iv or salt fails", async () => {
    const wrap = await wrapWithPassword(entropy, PASSWORD, random, CHEAP);
    const blob = newVault(entropy, wrap);
    for (const bad of [
      { ...wrap, ct: flip(wrap.ct) },
      { ...wrap, iv: flip(wrap.iv) },
      { ...wrap, kdf: { ...wrap.kdf, salt: flip(wrap.kdf.salt) } },
    ] as PasswordWrap[]) {
      await expect(unlockWithPassword(blob, bad, PASSWORD)).rejects.toThrow();
    }
  });

  it("a ciphertext moved to another account's blob fails (the account is bound into it)", async () => {
    const other = entropyFromPhrase(newPhrase(12));
    const wrap = await wrapWithPassword(entropy, PASSWORD, random, CHEAP);
    const otherWrap = await wrapWithPassword(other, PASSWORD, random, CHEAP);
    const blob = newVault(other, otherWrap);
    await expect(unlockWithPassword(blob, wrap, PASSWORD)).rejects.toThrow();
    // Even with the real wrap, claiming another account or public key in the metadata is refused.
    const real = newVault(entropy, wrap);
    await expect(
      unlockWithPassword({ ...real, accountId: blob.accountId }, wrap, PASSWORD),
    ).rejects.toThrow();
    await expect(
      unlockWithPassword({ ...real, publicKey: blob.publicKey }, wrap, PASSWORD),
    ).rejects.toThrow();
  });

  it("uses the documented Argon2id cost for every new wallet password", async () => {
    expect(KDF_PARAMS).toEqual({ t: 3, m: 19_456, p: 1 });
    const wrap = await wrapWithPassword(entropy, PASSWORD, random);
    expect(wrap.kdf).toMatchObject({ alg: "argon2id", t: 3, m: 19_456, p: 1 });
    expect(base64.decode(wrap.kdf.salt)).toHaveLength(16);
    expect(await unlockWithPassword(newVault(entropy, wrap), wrap, PASSWORD)).toBeTruthy();
  }, 60_000);

  it("gives each wrap its own salt and iv", async () => {
    const a = await wrapWithPassword(entropy, PASSWORD, random, CHEAP);
    const b = await wrapWithPassword(entropy, PASSWORD, random, CHEAP);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("passkey protection (the PRF output is the key)", () => {
  const meta = {
    credentialId: "cred",
    prfSalt: base64.encode(new Uint8Array(32)),
    rpId: "wallet.veylo.test",
  };
  const prf = random(32);

  it("unlocks with the same PRF output and fails with any other", async () => {
    const wrap = await wrapWithPasskey(entropy, prf, meta, random);
    const blob = newVault(entropy, wrap);
    expect((await unlockWithPasskey(blob, wrap, prf)).length).toBe(entropy.length);
    await expect(unlockWithPasskey(blob, wrap, random(32))).rejects.toThrow(/did not unlock/);
  });

  it("a tampered ciphertext fails, and a passkey wrap can't be passed off as a password wrap", async () => {
    const wrap = await wrapWithPasskey(entropy, prf, meta, random);
    const blob = newVault(entropy, wrap);
    await expect(
      unlockWithPasskey(blob, { ...wrap, ct: flip(wrap.ct) } as PasskeyWrap, prf),
    ).rejects.toThrow();
    // The same ciphertext presented as a password wrap has different associated data: it fails.
    const asPassword: PasswordWrap = {
      kind: "password",
      kdf: { alg: "argon2id", ...CHEAP, salt: base64.encode(new Uint8Array(16)) },
      iv: wrap.iv,
      ct: wrap.ct,
    };
    await expect(unlockWithPassword(blob, asPassword, PASSWORD)).rejects.toThrow();
  });
});

describe("isVaultBlob", () => {
  it("accepts a real blob and ignores anything else found in storage", async () => {
    const blob = newVault(entropy, await wrapWithPassword(entropy, PASSWORD, random, CHEAP));
    expect(isVaultBlob(blob)).toBe(true);
    for (const junk of [
      null,
      1,
      "x",
      {},
      { v: 2 },
      { ...blob, wraps: [] },
      { ...blob, wraps: [{ kind: "x" }] },
    ])
      expect(isVaultBlob(junk)).toBe(false);
  });
});
