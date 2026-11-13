// Browser gates A, deadline, B, B2 and C (slice W1). Real fixtures:
// - Gate A and C: the T5b live payout quote, signed by 1Click's real key, and the intent 1Click
//   generated for it (verification/results/T5b-payout-*.json, copied as data, L5).
// - Gate B: the slice 3b golden-vector record and messages, signed with the vectors' throwaway key.
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import {
  approvalExpiry,
  canonicalPayeeRecord,
  getPayoutRoute,
  type PayeeRecord,
} from "@veylo/core";
import {
  buildApprovalMessage,
  buildHeadMessage,
  hashNep413,
  nonceSaltHex,
  payeeRecordHash,
  payeeSetHash,
} from "@veylo/intents";
import { describe, expect, it } from "vitest";
import {
  createIndexedDbHighWater,
  createMemoryHighWater,
  gateC,
  feeWithinBound,
  gateB2,
  maxFeeUnits,
  PINNED_ONECLICK_QUOTE_KEY,
  runGates,
  signingBound,
  type GateRpc,
  type HighWaterStore,
} from "./index.js";
import { parseCanonicalRecord, verifyRegistry } from "./registry.js";
import { readSignedQuote } from "./signed-quote.js";

const fixture = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const QUOTE = fixture("../../../../packages/intents/src/fixtures/quote-payout-live.json").body;
const PAYLOAD = fixture("./fixtures/t5b-generated-intent.json").payload as {
  message: string;
  nonce: string;
  recipient: string;
};
const SALT = nonceSaltHex(PAYLOAD.nonce) as string;

/** The dev treasury that signed T5b (implicit account, public data). */
const TREASURY = "a87a0e4f93085edbe787aa4530021045f426c8fbc500a7c1dbd729dc4f8151ce";
/** The golden vectors' throwaway key. It controls nothing. */
const SECRET = new Uint8Array(32).fill(7);
const TREASURY_KEY = `ed25519:${base58.encode(ed25519.getPublicKey(SECRET))}`;
const OTHER_SECRET = new Uint8Array(32).fill(9);
const OTHER_KEY = `ed25519:${base58.encode(ed25519.getPublicKey(OTHER_SECRET))}`;
const WALLET_KEY = TREASURY_KEY;
const AUTH = "veylo.app";
const ORG = "11111111-1111-4111-8111-111111111111";
const CONTRACTOR = "22222222-2222-4222-8222-222222222222";
const DESTINATION = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-05T17:35:00.000Z");

const sign = (message: string, nonce: Uint8Array, secret: Uint8Array = SECRET) =>
  base64.encode(ed25519.sign(hashNep413({ message, nonce, recipient: AUTH }), secret));

const record = (over: Partial<PayeeRecord> = {}): PayeeRecord => {
  const approvedAt = over.approvedAt ?? new Date("2026-11-05T10:00:00.000Z");
  return {
    orgId: ORG,
    contractorId: CONTRACTOR,
    destinationId: DESTINATION,
    routeId: "usdc-base",
    recipient: "0xAf780910c0E7D41430D4615A437676a87a332C8C",
    recipientType: "DESTINATION_CHAIN",
    version: 1,
    approvedAt,
    expiresAt: approvalExpiry(approvedAt),
    ...over,
  };
};

let id = 0;
function registry(
  records: PayeeRecord[],
  opts: { version?: number; signedAt?: Date; secret?: Uint8Array; key?: string } = {},
) {
  const secret: Uint8Array = opts.secret ?? SECRET;
  const key = opts.key ?? TREASURY_KEY;
  const approvals = records.map((r) => {
    const nonce = new Uint8Array(32).fill(++id % 250);
    const message = buildApprovalMessage({
      record: r,
      contractorName: "Ada Lovelace",
      routeLabel: getPayoutRoute(r.routeId as never).label,
    });
    return {
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(id).padStart(12, "0")}`,
      destinationId: r.destinationId,
      version: r.version,
      contractorName: "Ada Lovelace",
      ownerAccountId: TREASURY,
      ownerPublicKey: key,
      signature: sign(message, nonce, secret),
      approvedAt: r.approvedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      nonce: base64.encode(nonce),
      message,
      recipient: AUTH,
      recordHash: payeeRecordHash(r),
      canonicalRecord: canonicalPayeeRecord(r),
    };
  });
  const recordHashes = records.map(payeeRecordHash);
  const version = opts.version ?? 3;
  const signedAt = opts.signedAt ?? new Date("2026-11-05T10:00:00.000Z");
  const headNonce = new Uint8Array(32).fill(200);
  const headMessage = buildHeadMessage({ orgId: ORG, version, recordHashes, signedAt });
  return {
    head: {
      version,
      activeSetHash: payeeSetHash(recordHashes),
      ownerPublicKey: key,
      signature: sign(headMessage, headNonce, secret),
      signedAt: signedAt.toISOString(),
      nonce: base64.encode(headNonce),
      message: headMessage,
      recipient: AUTH,
      recordHashes,
      signerAccountId: TREASURY,
    },
    approvals,
  };
}
function canonical(r: PayeeRecord) {
  return JSON.stringify({
    schema: "veylo.payee.v1",
    orgId: r.orgId,
    contractorId: r.contractorId,
    destinationId: r.destinationId,
    routeId: r.routeId,
    recipient: r.recipient,
    recipientType: r.recipientType,
    version: String(r.version),
    approvedAt: r.approvedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  });
}

const rpc = (over: Partial<GateRpc> = {}): GateRpc => ({
  isAccountKey: async (account, key) => account === TREASURY && key === TREASURY_KEY,
  hasPublicKey: async (verifier, account, key) =>
    verifier === "intents.far" && account === TREASURY && key === WALLET_KEY,
  currentSalt: async () => SALT,
  ...over,
});

const item = (over: Record<string, unknown> = {}) =>
  ({
    id: "44444444-4444-4444-8444-444444444444",
    contractorId: CONTRACTOR,
    destinationId: DESTINATION,
    amount: "0.100000",
    memo: null,
    flags: [],
    blocked: false,
    feePreview: null,
    mode: "live",
    attempt: null,
    ...over,
  }) as never;

const signRequest = (quote: unknown = QUOTE, payload = PAYLOAD) =>
  ({
    requestId: "55555555-5555-4555-8555-555555555555",
    payload,
    expiresAt: "2027-01-01T00:00:00.000Z",
    summary: "",
    gate: { treasuryAccountId: TREASURY, quote, payeeApproval: null, registryHead: null },
  }) as never;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

async function run(
  over: {
    registry?: unknown;
    items?: { item: never; signRequest: never | undefined }[];
    rpc?: GateRpc;
    highWater?: HighWaterStore;
    now?: Date;
    walletPublicKey?: string;
    treasuryAccountId?: string;
  } = {},
) {
  return runGates({
    orgId: ORG,
    treasuryAccountId: over.treasuryAccountId ?? TREASURY,
    walletPublicKey: over.walletPublicKey ?? WALLET_KEY,
    authRecipient: AUTH,
    deadlineMinutes: 15,
    registry: ("registry" in over ? over.registry : registry([record()])) as never,
    items: over.items ?? [{ item: item(), signRequest: signRequest() }],
    rpc: over.rpc ?? rpc(),
    highWater: over.highWater ?? createMemoryHighWater(),
    now: over.now ?? NOW,
  });
}
const gate = (report: Awaited<ReturnType<typeof run>>, name: string) =>
  report.items[0]?.gates.find((g) => g.gate === name);

describe("all gates on real fixtures", () => {
  it("pass, and only then allPassed", async () => {
    const report = await run();
    expect(report.items[0]?.gates.map((g) => [g.gate, g.passed, g.reason])).toEqual([
      ["A", true, "ok"],
      ["deadline", true, "ok"],
      ["B", true, "ok"],
      ["B2", true, "ok"],
      ["C", true, "ok"],
    ]);
    expect(report.allPassed).toBe(true);
  });

  it("no items is never allPassed", async () => {
    expect((await run({ items: [] })).allPassed).toBe(false);
  });
});

describe("gate A: 1Click's signature against the pinned key", () => {
  it("pins exactly the reviewed key", () => {
    expect(PINNED_ONECLICK_QUOTE_KEY).toBe("ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc");
  });

  it.each([
    [
      "recipient",
      (q: any) => (q.quoteRequest.recipient = "0x000000000000000000000000000000000000dEaD"),
    ],
    ["amountOut", (q: any) => (q.quote.amountOut = "1")],
    ["amountIn", (q: any) => (q.quote.amountIn = "999999")],
    [
      "destinationAsset (route)",
      (q: any) => (q.quoteRequest.destinationAsset = getPayoutRoute("usdc-arbitrum").assetId),
    ],
    ["depositAddress", (q: any) => (q.quote.depositAddress = "f".repeat(64))],
    ["refundTo", (q: any) => (q.quoteRequest.refundTo = "attacker.near")],
    ["timestamp", (q: any) => (q.timestamp = "2026-11-05T17:34:00.000Z")],
    ["signature", (q: any) => (q.signature = `ed25519:${base58.encode(new Uint8Array(64))}`)],
  ])("a tampered signed field (%s) fails A, and nothing signs", async (_name, tamper) => {
    const q = clone(QUOTE);
    tamper(q);
    const report = await run({ items: [{ item: item(), signRequest: signRequest(q) }] });
    expect(gate(report, "A")).toMatchObject({ passed: false });
    expect(report.allPassed).toBe(false);
  });

  it.each([
    ["appFees", (q: any) => (q.quoteRequest.appFees = [{ recipient: "attacker.near", fee: 9000 }])],
    ["confidentiality", (q: any) => (q.quoteRequest.confidentiality = "public")],
    ["insured", (q: any) => (q.quoteRequest.insured = true)],
    ["depositMode", (q: any) => (q.quoteRequest.depositMode = "MEMO")],
  ])("an unsigned field (%s) changes no decision", async (_name, tamper) => {
    const q = clone(QUOTE);
    tamper(q);
    const before = await run();
    const after = await run({ items: [{ item: item(), signRequest: signRequest(q) }] });
    expect(after).toEqual(before);
    expect(readSignedQuote(q)).toEqual(readSignedQuote(QUOTE));
  });

  it("a quote missing or malformed fails closed", async () => {
    for (const q of [undefined, null, {}, { quote: {}, quoteRequest: {} }]) {
      const sr = signRequest() as any;
      sr.gate.quote = q;
      const report = await run({ items: [{ item: item(), signRequest: sr }] });
      expect(gate(report, "A")?.passed).toBe(false);
      expect(report.allPassed).toBe(false);
    }
  });
});

describe("signing deadline: signed timestamp + PAYOUT_QUOTE_DEADLINE_MINUTES (L35)", () => {
  it("is computed from the signed timestamp", () => {
    expect(signingBound(readSignedQuote(QUOTE)!, 15).toISOString()).toBe(
      "2026-11-05T17:45:50.957Z",
    );
  });

  it("fails once less than a minute is left, whatever the served expiry says", async () => {
    const report = await run({ now: new Date("2026-11-05T17:45:00.000Z") });
    expect(gate(report, "deadline")).toMatchObject({ passed: false });
    expect(report.allPassed).toBe(false);
  });
});

describe("gate B: the owner-signed payee registry", () => {
  it("a different signed recipient for the destination fails B", async () => {
    const report = await run({
      registry: registry([record({ recipient: "0x000000000000000000000000000000000000dEaD" })]),
    });
    expect(gate(report, "B")).toMatchObject({
      passed: false,
      reason: "the quote pays another recipient",
    });
  });

  it("a different signed route fails B", async () => {
    const report = await run({ registry: registry([record({ routeId: "usdc-arbitrum" })]) });
    expect(gate(report, "B")).toMatchObject({
      passed: false,
      reason: "the quote pays on another route",
    });
  });

  it("a registry version below the high-water mark is a rollback, even though validly signed", async () => {
    const report = await run({ highWater: createMemoryHighWater({ [ORG]: 4 }) });
    expect(gate(report, "B")?.passed).toBe(false);
    expect(gate(report, "B")?.reason).toMatch(/rollback/);
    expect(report.allPassed).toBe(false);
  });

  it("an equal or higher version passes, and raises the mark", async () => {
    const highWater = createMemoryHighWater({ [ORG]: 3 });
    expect((await run({ highWater })).allPassed).toBe(true);
    await run({ highWater, registry: registry([record()], { version: 7 }) });
    expect(await highWater.get(ORG)).toBe(7);
    expect(gate(await run({ highWater }), "B")?.reason).toMatch(/rollback/);
  });

  it("an expired approval fails B", async () => {
    const later = new Date(record().expiresAt.getTime() + 1000);
    const report = await run({ now: later });
    expect(gate(report, "B")).toMatchObject({
      passed: false,
      reason: "the payee approval has expired",
    });
  });

  it("an approval claiming more than 180 days fails B", async () => {
    const r = record();
    const long = record({ expiresAt: new Date(r.approvedAt.getTime() + 181 * 86_400_000) });
    const report = await run({ registry: registry([long]) });
    expect(gate(report, "B")?.reason).toMatch(/180 days/);
  });

  it("a superseded destination still in the head blocks the contractor (L29)", async () => {
    const old = record({ destinationId: "66666666-6666-4666-8666-666666666666", version: 1 });
    const report = await run({ registry: registry([old, record({ version: 2 })]) });
    expect(gate(report, "B")).toMatchObject({
      passed: false,
      reason: "superseded destination still in the registry head",
    });
  });

  it("a withheld approval (served set smaller than the head's) fails B", async () => {
    const other = record({
      contractorId: "77777777-7777-4777-8777-777777777777",
      destinationId: "88888888-8888-4888-8888-888888888888",
    });
    const full = registry([record(), other]);
    const report = await run({ registry: { ...full, approvals: full.approvals.slice(0, 1) } });
    expect(gate(report, "B")?.reason).toMatch(/exactly the head's set/);
  });

  it.each([
    ["the head's set hash", (r: any) => (r.head.activeSetHash = "0".repeat(64))],
    ["the head's version", (r: any) => (r.head.version = 9)],
    ["the head's signer", (r: any) => (r.head.signerAccountId = "attacker.near")],
    ["the head's app", (r: any) => (r.head.recipient = "evil.app")],
    [
      "an approval's canonical record",
      (r: any) =>
        (r.approvals[0].canonicalRecord = r.approvals[0].canonicalRecord.replace(
          "0xAf78",
          "0xBf78",
        )),
    ],
    ["an approval's signer", (r: any) => (r.approvals[0].ownerAccountId = "attacker.near")],
    [
      "an approval's signature",
      (r: any) => (r.approvals[0].signature = base64.encode(new Uint8Array(64))),
    ],
  ])("tampering with %s fails B", async (_name, tamper) => {
    const r = clone(registry([record()]));
    tamper(r);
    const report = await run({ registry: r });
    expect(gate(report, "B")?.passed).toBe(false);
    expect(report.allPassed).toBe(false);
  });

  it("a registry signed by a key that isn't the treasury's (per NEAR RPC) fails B", async () => {
    const report = await run({
      registry: registry([record()], { secret: OTHER_SECRET, key: OTHER_KEY }),
    });
    expect(gate(report, "B")?.reason).toMatch(/full-access key of the treasury/);
  });

  it("an API-served treasury that isn't the wallet's account changes nothing: the wallet's is used", async () => {
    const sr = signRequest() as any;
    sr.gate.treasuryAccountId = "attacker.near";
    const report = await run({ items: [{ item: item(), signRequest: sr }] });
    expect(report.allPassed).toBe(true);
  });

  it("no registry, or no head, fails B", async () => {
    expect(gate(await run({ registry: undefined }), "B")?.passed).toBe(false);
    expect(gate(await run({ registry: { head: null, approvals: [] } }), "B")?.passed).toBe(false);
  });

  it("an RPC error during the key check fails B", async () => {
    const report = await run({
      rpc: rpc({ isAccountKey: () => Promise.reject(new Error("timeout")) }),
    });
    expect(gate(report, "B")?.passed).toBe(false);
    expect(report.allPassed).toBe(false);
  });
});

describe("high-water storage fails closed", () => {
  it("missing IndexedDB throws, and the gate fails", async () => {
    await expect(createIndexedDbHighWater(undefined).get(ORG)).rejects.toThrow(/not available/);
    const report = await run({ highWater: createIndexedDbHighWater(undefined) });
    expect(gate(report, "B")?.passed).toBe(false);
    expect(report.allPassed).toBe(false);
  });

  it("a store that fails to read or write fails the gate", async () => {
    const broken: HighWaterStore = {
      get: () => Promise.reject(new Error("quota")),
      raise: async () => {},
    };
    expect((await run({ highWater: broken })).allPassed).toBe(false);
    const readOnly: HighWaterStore = {
      get: async () => 0,
      raise: () => Promise.reject(new Error("quota")),
    };
    expect((await run({ highWater: readOnly })).allPassed).toBe(false);
  });

  it("an IndexedDB that fails to open fails closed", async () => {
    const factory = {
      open: () => {
        throw new Error("SecurityError");
      },
    } as unknown as IDBFactory;
    await expect(createIndexedDbHighWater(factory).get(ORG)).rejects.toThrow(/failed to open/);
  });
});

describe("gate B2: the wallet's key is registered for the treasury", () => {
  it("an unregistered key fails B2", async () => {
    const report = await run({ rpc: rpc({ hasPublicKey: async () => false }) });
    expect(gate(report, "B2")?.passed).toBe(false);
  });

  it("an RPC error fails B2", async () => {
    const report = await run({
      rpc: rpc({ hasPublicKey: () => Promise.reject(new Error("429")) }),
    });
    expect(gate(report, "B2")?.passed).toBe(false);
  });

  it("checks the confidential verifier the payload is signed for", async () => {
    const asked: string[] = [];
    await run({ rpc: rpc({ hasPublicKey: async (v) => (asked.push(v), true) }) });
    expect(asked).toEqual(["intents.far"]);
  });

  it("checks intents.near when the payload names intents.near", async () => {
    const asked: string[] = [];
    const result = await gateB2({
      treasuryAccountId: TREASURY,
      walletPublicKey: WALLET_KEY,
      verifier: "intents.near",
      rpc: rpc({ hasPublicKey: async (v) => (asked.push(v), v === "intents.near") }),
    });
    expect(asked).toEqual(["intents.near"]);
    expect(result.passed).toBe(true);
  });

  it("fails B2 for a verifier that isn't pinned, without asking RPC", async () => {
    for (const verifier of ["evil.near", "intents.near.evil", "", "INTENTS.FAR"]) {
      const result = await gateB2({
        treasuryAccountId: TREASURY,
        walletPublicKey: WALLET_KEY,
        verifier,
        rpc: rpc({ hasPublicKey: () => Promise.reject(new Error("must not be called")) }),
      });
      expect(result).toMatchObject({ gate: "B2", passed: false });
      expect(result.reason).toMatch(/unknown verifier/);
    }
  });

  it("an implicit treasury signing with its own key needs no registration", async () => {
    const implicitKey = ed25519.getPublicKey(SECRET);
    const implicit = Array.from(implicitKey, (b) => b.toString(16).padStart(2, "0")).join("");
    const report = await run({
      treasuryAccountId: implicit,
      rpc: rpc({ hasPublicKey: () => Promise.reject(new Error("must not be called")) }),
    });
    expect(gate(report, "B2")?.passed).toBe(true);
  });
});

describe("gate C: amount and payload", () => {
  it("a different item amount fails C", async () => {
    for (const amount of ["0.090000", "0.200000", "0.100001"]) {
      const report = await run({ items: [{ item: item({ amount }), signRequest: signRequest() }] });
      expect(gate(report, "C")?.passed).toBe(false);
      expect(report.allPassed).toBe(false);
    }
  });

  it.each([
    ["receiver", (p: any) => (p.message = p.message.replace("58846af3", "00000000"))],
    ["amount", (p: any) => (p.message = p.message.replace('"105882"', '"205882"'))],
    ["token", (p: any) => (p.message = p.message.replace("imt:51e8f94d", "imt:00000000"))],
    [
      "signer",
      (p: any) =>
        (p.message = p.message.replace(`"signer_id":"${TREASURY}"`, '"signer_id":"attacker.near"')),
    ],
    ["verifier", (p: any) => (p.recipient = "intents.near")],
    ["nonce salt", (p: any) => (p.nonce = base64.encode(new Uint8Array(32)))],
  ])("a payload with the wrong %s fails C", async (_name, tamper) => {
    const p = clone(PAYLOAD);
    tamper(p);
    const report = await run({ items: [{ item: item(), signRequest: signRequest(QUOTE, p) }] });
    expect(gate(report, "C")?.passed).toBe(false);
    expect(report.allPassed).toBe(false);
  });

  it("an RPC error reading the salt fails C", async () => {
    const report = await run({
      rpc: rpc({ currentSalt: () => Promise.reject(new Error("down")) }),
    });
    expect(gate(report, "C")?.passed).toBe(false);
  });

  it("bounds the fee: max(1 USDC, 1% of the payout) (L45)", () => {
    expect(maxFeeUnits(100_000n)).toBe(1_000_000n);
    // 1% of 100 USDC is exactly 1 USDC: the floor and the percentage meet.
    expect(maxFeeUnits(100_000_000n)).toBe(1_000_000n);
    // Above 100 USDC the 1% governs: 1,000 USDC allows 10 USDC, never 20 (the old 2%).
    expect(maxFeeUnits(1_000_000_000n)).toBe(10_000_000n);
    expect(maxFeeUnits(1_000_000_001n)).toBe(10_000_000n);
    expect(maxFeeUnits(1_000_000_100n)).toBe(10_000_001n);
    expect(
      gateC({
        item: item(),
        quote: QUOTE,
        payload: PAYLOAD,
        treasuryAccountId: TREASURY,
        saltHex: SALT,
      }),
    ).toMatchObject({ passed: true });
  });
});

describe("gate C: fee ceiling boundary (L45)", () => {
  const U = 1_000_000n; // 1 USDC in units
  it("small payouts: up to 1 USDC over passes, one unit more fails", () => {
    expect(feeWithinBound(100_000n + U, 100_000n)).toBe(true);
    expect(feeWithinBound(100_000n + U + 1n, 100_000n)).toBe(false);
  });
  it("large payouts: up to 1% over passes, one unit more fails", () => {
    const p = 1_000n * U; // 1,000 USDC: ceiling 10 USDC
    expect(feeWithinBound(p + 10n * U, p)).toBe(true);
    expect(feeWithinBound(p + 10n * U + 1n, p)).toBe(false);
    // The old 2% ceiling (20 USDC) is now refused.
    expect(feeWithinBound(p + 20n * U, p)).toBe(false);
  });
  it("a signed amount below the payout fails", () => {
    expect(feeWithinBound(99_999n, 100_000n)).toBe(false);
  });
  it("the live fixture's fee (0.005882 USDC on 0.1 USDC) is within the ceiling", () => {
    const s = readSignedQuote(QUOTE)!;
    expect(feeWithinBound(BigInt(s.amountIn), BigInt(s.amountOut))).toBe(true);
  });
  it("a payout payload for intents.near fails C until spike S-N", () => {
    const r = gateC({
      item: item(),
      quote: QUOTE,
      payload: { ...PAYLOAD, recipient: "intents.near" },
      treasuryAccountId: TREASURY,
      saltHex: SALT,
    });
    expect(r).toMatchObject({ passed: false });
    expect(r.reason).toMatch(/S-N/);
  });
});

describe("fail closed", () => {
  it("an item with no sign request fails every gate", async () => {
    const report = await run({ items: [{ item: item(), signRequest: undefined }] });
    expect(report.items[0]?.gates.every((g) => !g.passed)).toBe(true);
    expect(report.allPassed).toBe(false);
  });

  it("one failing item blocks allPassed for the whole run", async () => {
    const report = await run({
      items: [
        { item: item(), signRequest: signRequest() },
        {
          item: item({ id: "99999999-9999-4999-8999-999999999999", amount: "0.200000" }),
          signRequest: signRequest(),
        },
      ],
    });
    expect(report.items.map((i) => i.passed)).toEqual([true, false]);
    expect(report.allPassed).toBe(false);
  });
});

describe("golden vectors (slice 3b) through gate B's verification", () => {
  const GOLDEN_CANONICAL =
    '{"schema":"veylo.payee.v1","orgId":"11111111-1111-4111-8111-111111111111","contractorId":"22222222-2222-4222-8222-222222222222","destinationId":"33333333-3333-4333-8333-333333333333","routeId":"usdc-base","recipient":"0xAf780910c0E7D41430D4615A437676a87a332C8C","recipientType":"DESTINATION_CHAIN","version":"1","approvedAt":"2026-11-06T10:00:00.000Z","expiresAt":"2027-05-05T10:00:00.000Z"}';
  const GOLDEN_HASH = "e043a6e73e11a11edc0f5e2180f46f1e13339ef53f84d055b66b565c7ef60770";

  it("the golden record round-trips and hashes to the golden hash", () => {
    const r = parseCanonicalRecord(GOLDEN_CANONICAL);
    expect(r).toBeDefined();
    expect(payeeRecordHash(r!)).toBe(GOLDEN_HASH);
    expect(canonical(r!)).toBe(GOLDEN_CANONICAL);
  });

  it("a registry built from the golden record verifies, and any reformatting of its text fails", async () => {
    const r = parseCanonicalRecord(GOLDEN_CANONICAL)!;
    const reg = registry([r], { signedAt: new Date("2026-11-06T10:00:00.000Z") });
    const now = new Date("2026-11-06T12:00:00.000Z");
    const ok = await verifyRegistry({
      orgId: ORG,
      treasuryAccountId: TREASURY,
      authRecipient: AUTH,
      registry: reg as never,
      rpc: rpc(),
      highWater: createMemoryHighWater(),
      now,
    });
    expect(ok.ok).toBe(true);
    const spaced = clone(reg);
    spaced.approvals[0]!.canonicalRecord = GOLDEN_CANONICAL.replace(
      '"version":"1"',
      '"version": "1"',
    );
    const bad = await verifyRegistry({
      orgId: ORG,
      treasuryAccountId: TREASURY,
      authRecipient: AUTH,
      registry: spaced as never,
      rpc: rpc(),
      highWater: createMemoryHighWater(),
      now,
    });
    expect(bad.ok).toBe(false);
  });
});

describe("signed record parsing", () => {
  it("reads multi-digit versions exactly, and refuses non-canonical ones", () => {
    for (const v of [1, 9, 12, 345, 999_999_999]) {
      const r = record({ version: v });
      expect(parseCanonicalRecord(canonicalPayeeRecord(r))?.version).toBe(v);
    }
    const text = canonicalPayeeRecord(record({ version: 12 }));
    for (const bad of ['"version":"012"', '"version":"1.5"', '"version":"-1"', '"version":"1e3"']) {
      expect(parseCanonicalRecord(text.replace('"version":"12"', bad))).toBeUndefined();
    }
  });
});
