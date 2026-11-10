// `pnpm verify` reports this file as its address-validation check (ARCHITECTURE §11.1).
import { randomBytes } from "node:crypto";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
  validateAddress,
  validateEvmAddress,
  validateNearAccountId,
  validateSolanaAddress,
} from "./index.js";

const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);

describe("EVM", () => {
  // The test vectors published in EIP-55.
  const EIP55 = [
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
    "0xde709f2102306220921060314715629080e2fb77",
    "0x27b1fdb04752bbc536007a920d24acb045561c26",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ];

  it.each(EIP55)("accepts the EIP-55 vector %s unchanged", (address) => {
    expect(validateEvmAddress(address)).toEqual({ ok: true, kind: "evm", normalized: address });
  });

  it.each(EIP55)("normalizes the lowercase form of %s to checksum form", (address) => {
    const result = validateEvmAddress(address.toLowerCase());
    expect(result).toMatchObject({ ok: true, normalized: address });
  });

  it("rejects mixed case with a bad checksum", () => {
    const bad = "0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    expect(reason(validateEvmAddress(bad))).toBe("evm_bad_checksum");
  });

  it("rejects all upper case unless that happens to be the checksum", () => {
    const upper = `0x${"5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed".toUpperCase()}`;
    expect(reason(validateEvmAddress(upper))).toBe("evm_bad_checksum");
  });

  it.each([
    "",
    "0x",
    "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0X5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAedd",
    "0xgaAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    " 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed\n",
  ])("rejects the malformed %j", (address) => {
    expect(reason(validateEvmAddress(address))).toBe("evm_format");
  });

  it("rejects the zero address", () => {
    expect(reason(validateEvmAddress(`0x${"0".repeat(40)}`))).toBe("evm_zero_address");
  });

  it("property: lowercase normalizes, and the result validates to itself", () => {
    for (let i = 0; i < 300; i += 1) {
      const lower = `0x${randomBytes(20).toString("hex")}`;
      const first = validateEvmAddress(lower);
      if (!first.ok) throw new Error(lower);
      expect(first.normalized.toLowerCase()).toBe(lower);
      expect(validateEvmAddress(first.normalized)).toEqual(first);
    }
  });

  it("property: flipping the case of any one letter breaks the checksum", () => {
    for (let i = 0; i < 100; i += 1) {
      const result = validateEvmAddress(`0x${randomBytes(20).toString("hex")}`);
      if (!result.ok) throw new Error("expected valid");
      const hex = result.normalized.slice(2);
      const at = [...hex].findIndex((c) => /[a-fA-F]/.test(c));
      if (at < 0) continue;
      const c = hex[at] as string;
      const flipped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
      const bad = `0x${hex.slice(0, at)}${flipped}${hex.slice(at + 1)}`;
      // An all-lowercase result would be accepted as unchecksummed, which is the rule.
      if (bad.slice(2) === bad.slice(2).toLowerCase()) continue;
      expect(reason(validateEvmAddress(bad))).toBe("evm_bad_checksum");
    }
  });
});

describe("Solana", () => {
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  it("accepts a real 32-byte address unchanged", () => {
    expect(validateSolanaAddress(USDC_MINT)).toEqual({
      ok: true,
      kind: "solana",
      normalized: USDC_MINT,
    });
  });

  it("rejects the system program (all zero bytes)", () => {
    expect(reason(validateSolanaAddress("1".repeat(32)))).toBe("solana_system_program");
  });

  it.each(["0OIl", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1O", "has space"])(
    "rejects non-base58 %j",
    (address) => {
      expect(reason(validateSolanaAddress(address))).toBe("solana_format");
    },
  );

  it.each([31, 33, 64])("rejects %i bytes", (size) => {
    const address = base58.encode(new Uint8Array(size).fill(7));
    expect(reason(validateSolanaAddress(address))).toBe("solana_wrong_length");
  });

  it("property: any non-zero 32 bytes round-trips", () => {
    for (let i = 0; i < 200; i += 1) {
      const address = base58.encode(randomBytes(32));
      expect(validateSolanaAddress(address)).toMatchObject({ ok: true, normalized: address });
    }
  });
});

describe("NEAR", () => {
  // Examples from the account ID rules in the NEAR specification.
  it.each([
    "ok",
    "bowen",
    "ek-2",
    "ek.near",
    "com",
    "google.com",
    "bowen.google.com",
    "near",
    "illia.cheap-accounts.near",
    "max_99.near",
    "100",
    "near2019",
    "over.9000",
    "a.bro",
    "bro.a",
  ])("accepts the named account %s", (id) => {
    expect(validateNearAccountId(id)).toMatchObject({ ok: true, kind: "near_named" });
  });

  it("recognizes an implicit account", () => {
    const id = randomBytes(32).toString("hex");
    expect(validateNearAccountId(id)).toEqual({ ok: true, kind: "near_implicit", normalized: id });
  });

  it("treats 64 characters that aren't lowercase hex as named", () => {
    expect(validateNearAccountId("z".repeat(64))).toMatchObject({ kind: "near_named" });
  });

  it.each(["", "a", "a".repeat(65)])("rejects the length of %j", (id) => {
    expect(reason(validateNearAccountId(id))).toBe("near_length");
  });

  it.each([
    "not ok",
    "Alice.near",
    "bro..near",
    ".near",
    "near.",
    "a-",
    "-a",
    "a--b",
    "a__b",
    "a-_b",
    "abc\ndef",
    "a@b.near",
    "A".repeat(64),
  ])("rejects the format of %j", (id) => {
    expect(reason(validateNearAccountId(id))).toBe("near_format");
  });
});

describe("validateAddress", () => {
  it("dispatches by kind", () => {
    expect(validateAddress("evm", "bob.near").ok).toBe(false);
    expect(validateAddress("near", "bob.near").ok).toBe(true);
    expect(validateAddress("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").ok).toBe(true);
  });
});
