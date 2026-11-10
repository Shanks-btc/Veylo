import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretBox, SecretError } from "./index.js";

const random = (n: number) => randomBytes(n);
const MASTER = randomBytes(32).toString("base64");
const box = createSecretBox({ masterKey: MASTER, random });
const BINDING = { orgId: "org-a", purpose: "oneclick.access", recordId: "row-1" };
const SECRET = "token-sentinel";

function flip(sealed: string): string {
  const [v, n, c] = sealed.split(".");
  const bytes = Buffer.from(c as string, "base64");
  bytes[0] = (bytes[0] as number) ^ 1;
  return `${v}.${n}.${bytes.toString("base64")}`;
}

describe("envelope encryption", () => {
  const key = box.newWrappedDataKey("org-a");
  const sealed = box.encrypt(key, BINDING, SECRET);

  it("round trips", () => {
    expect(box.decrypt(key, BINDING, sealed)).toBe(SECRET);
  });

  it("the ciphertext and wrapped key don't contain the plaintext", () => {
    expect(sealed).not.toContain(SECRET);
    expect(Buffer.from(sealed.split(".")[2] as string, "base64").toString()).not.toContain(SECRET);
  });

  it("the same plaintext encrypts differently each time", () => {
    expect(box.encrypt(key, BINDING, SECRET)).not.toBe(sealed);
  });

  it("a tampered ciphertext fails", () => {
    expect(() => box.decrypt(key, BINDING, flip(sealed))).toThrow(SecretError);
  });

  it("a tampered wrapped key fails", () => {
    expect(() => box.decrypt(flip(key), BINDING, sealed)).toThrow(SecretError);
  });

  it.each([
    ["record", { recordId: "row-2" }],
    ["purpose", { purpose: "oneclick.refresh" }],
  ])("wrong associated data fails: another %s", (_name, change) => {
    expect(() => box.decrypt(key, { ...BINDING, ...change }, sealed)).toThrow(SecretError);
  });

  it("another org fails, even with this org's wrapped key", () => {
    expect(() => box.decrypt(key, { ...BINDING, orgId: "org-b" }, sealed)).toThrow(SecretError);
  });

  it("another org's data key fails, with the binding kept", () => {
    const other = box.newWrappedDataKey("org-a");
    expect(() => box.decrypt(other, BINDING, sealed)).toThrow(SecretError);
  });

  it("the associated data can't be shifted between fields", () => {
    const one = box.encrypt(key, { ...BINDING, purpose: "a", recordId: "b,c" }, SECRET);
    expect(() => box.decrypt(key, { ...BINDING, purpose: "a,b", recordId: "c" }, one)).toThrow(
      SecretError,
    );
  });

  it("a wrong master key fails", () => {
    const other = createSecretBox({ masterKey: randomBytes(32).toString("base64"), random });
    expect(() => other.decrypt(key, BINDING, sealed)).toThrow(SecretError);
  });

  it("errors reveal nothing", () => {
    try {
      box.decrypt(key, { ...BINDING, orgId: "org-b" }, sealed);
    } catch (err) {
      expect((err as Error).message).toBe("could not decrypt secret");
    }
  });

  it.each(["", "v1", "v2.a.b", "v1..", "garbage"])("malformed %j fails", (text) => {
    expect(() => box.decrypt(key, BINDING, text)).toThrow(SecretError);
  });

  it("refuses a master key of the wrong size", () => {
    expect(() => createSecretBox({ masterKey: "c2hvcnQ=", random })).toThrow(RangeError);
  });
});
