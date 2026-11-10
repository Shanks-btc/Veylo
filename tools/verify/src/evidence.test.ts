import { createTestDb, seedLineItem } from "@veylo/db/test-db";
import { schema } from "@veylo/db";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { productEvidenceRows } from "./evidence-db.js";
import {
  checkRow,
  DEFAULT_EVIDENCE_RPCS,
  parseEvidence,
  renderEvidence,
  type EvidenceRow,
} from "./evidence.js";
import { PHASE2_ROWS } from "./phase2-evidence.js";

const RECIPIENT = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
const BASE_TX = "0xb8f7cd70174d9c3a951f137d1de7b76e4dcfdffd1fc11c78dc290b1fc0fb4aa8";
const NEAR_TX = "7Mm6ctWXUEdAFFfbZuH8V4NNpKeggfTrQxRf1vkBKgx";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const base: EvidenceRow = {
  date: "2026-11-05T15:28:07Z",
  event: "x",
  chain: "base",
  tx: BASE_TX,
  party: RECIPIENT,
  amount: { units: 500000n, symbol: "USDC", decimals: 6 },
  source: "s",
};
const near: EvidenceRow = { ...base, chain: "near", tx: NEAR_TX, party: "intents.near" };
delete (near as { amount?: unknown }).amount;

/** The receipt Base RPC returned live for this transaction (probed 2026-11-07). */
const receipt = (over: { to?: string; amount?: bigint; status?: string; token?: string } = {}) => ({
  result: {
    status: over.status ?? "0x1",
    logs: [
      {
        address: over.token ?? "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        topics: [
          TRANSFER,
          "0x0000000000000000000000002cff890f0378a11913b6129b2e97417a2c302680",
          `0x${(over.to ?? RECIPIENT).slice(2).toLowerCase().padStart(64, "0")}`,
        ],
        data: `0x${(over.amount ?? 500000n).toString(16).padStart(64, "0")}`,
      },
    ],
  },
});
const answer = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const check = (row: EvidenceRow, f: typeof fetch) => checkRow(row, DEFAULT_EVIDENCE_RPCS, f);

describe("EVM re-check", () => {
  it("passes on the exact transfer to the recipient", async () => {
    expect(await check(base, answer(receipt()))).toMatchObject({ status: "PASS" });
  });

  it("FAILS on a wrong amount", async () => {
    expect(await check(base, answer(receipt({ amount: 500001n })))).toMatchObject({
      status: "FAIL",
    });
  });

  it("FAILS on another recipient", async () => {
    expect(
      await check(base, answer(receipt({ to: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }))),
    ).toMatchObject({
      status: "FAIL",
    });
  });

  it("FAILS on another token", async () => {
    expect(
      await check(base, answer(receipt({ token: "0x0000000000000000000000000000000000000001" }))),
    ).toMatchObject({
      status: "FAIL",
    });
  });

  it("FAILS on a tampered hash (no receipt)", async () => {
    expect(
      await check({ ...base, tx: `0x${"1".repeat(64)}` }, answer({ result: null })),
    ).toMatchObject({
      status: "FAIL",
    });
  });

  it("FAILS on a reverted transaction", async () => {
    expect(await check(base, answer(receipt({ status: "0x0" })))).toMatchObject({ status: "FAIL" });
  });
});

describe("NEAR re-check", () => {
  it("passes on a final, successful transaction", async () => {
    const f = answer({ result: { final_execution_status: "FINAL", status: { SuccessValue: "" } } });
    expect(await check(near, f)).toMatchObject({ status: "PASS" });
  });

  it("FAILS on a tampered hash", async () => {
    const f = answer({ error: { cause: { name: "UNKNOWN_TRANSACTION" } } });
    expect(await check({ ...near, tx: "1".repeat(44) }, f)).toMatchObject({ status: "FAIL" });
  });

  it("FAILS on a failed transaction", async () => {
    const f = answer({ result: { final_execution_status: "FINAL", status: { Failure: {} } } });
    expect(await check(near, f)).toMatchObject({ status: "FAIL" });
  });
});

describe("Solana re-check", () => {
  const sol: EvidenceRow = { ...base, chain: "sol", tx: "5".repeat(88), party: "Owner1111" };
  const tx = (pre: string, post: string, err: unknown = null) =>
    answer({
      result: {
        meta: {
          err,
          preTokenBalances: [{ owner: "Owner1111", uiTokenAmount: { amount: pre } }],
          postTokenBalances: [{ owner: "Owner1111", uiTokenAmount: { amount: post } }],
        },
      },
    });
  it("passes when the recipient gains exactly the amount", async () => {
    expect(await check(sol, tx("1000", "501000"))).toMatchObject({ status: "PASS" });
  });
  it("FAILS on a wrong amount, a failure, or no transaction", async () => {
    expect(await check(sol, tx("1000", "501001"))).toMatchObject({ status: "FAIL" });
    expect(await check(sol, tx("1000", "501000", { err: 1 }))).toMatchObject({ status: "FAIL" });
    expect(await check(sol, answer({ result: null }))).toMatchObject({ status: "FAIL" });
  });
});

describe("FAIL only on definitive data", () => {
  it("NEAR UNKNOWN_TRANSACTION is definitive", async () => {
    const f = answer({ error: { cause: { name: "UNKNOWN_TRANSACTION" } } });
    expect(await check(near, f)).toMatchObject({ status: "FAIL" });
  });
  it("an EVM null receipt with no error is definitive", async () => {
    expect(await check(base, answer({ jsonrpc: "2.0", id: 1, result: null }))).toMatchObject({
      status: "FAIL",
    });
  });
  it("an EVM error alongside no result is not", async () => {
    const f = answer({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit exceeded" } });
    expect(await check(base, f)).toMatchObject({ status: "SKIPPED" });
  });
});

describe("never PASS when the network is unavailable", () => {
  it.each([
    [
      "no connection",
      vi.fn(async () => Promise.reject(new Error("ENOTFOUND"))) as unknown as typeof fetch,
    ],
    ["HTTP 503", answer({}, 503)],
    ["HTTP 500", answer({}, 500)],
    ["rate limited", answer({}, 429)],
    [
      "timeout",
      vi.fn(async () =>
        Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
      ) as unknown as typeof fetch,
    ],
    [
      "a JSON-RPC error",
      answer({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "busy" } }),
    ],
    ["a NEAR internal error", answer({ error: { cause: { name: "INTERNAL_ERROR" } } })],
    ["a NEAR timeout error", answer({ error: { cause: { name: "TIMEOUT_ERROR" } } })],
    [
      "an unreadable body",
      vi.fn(async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    ],
    ["an unexpected shape", answer({ result: { logs: "nope", status: "0x1" } })],
  ])("%s is SKIPPED", async (_n, f) => {
    expect((await check(base, f)).status).toBe("SKIPPED");
    expect((await check(near, f)).status).toBe("SKIPPED");
  });
});

describe("EVIDENCE.md", () => {
  it("is deterministic: the same rows give the same bytes, in any input order", () => {
    const a = renderEvidence([base, near]);
    expect(renderEvidence([near, base])).toBe(a);
    expect(a).not.toMatch(/generated at|\d{2}:\d{2}:\d{2}\.\d{3}/i);
  });

  it("round-trips every Phase 2 row through the file", () => {
    const parsed = parseEvidence(renderEvidence([]));
    const key = (r: EvidenceRow) => `${r.chain}:${r.tx}:${r.party}:${r.amount?.units ?? ""}`;
    expect(parsed.map(key).sort()).toEqual(PHASE2_ROWS.map(key).sort());
  });

  it("states which section is which, and says when Section 1 is empty", () => {
    const md = renderEvidence([]);
    expect(md).toContain("## Section 1: Product payouts");
    expect(md).toContain("## Section 2: Phase 2 verification transactions");
    expect(md).toContain("None yet.");
  });

  it("formats amounts as exact decimals", () => {
    expect(renderEvidence([base])).toContain("| 0.500000 USDC |");
    expect(renderEvidence([])).toContain("| 2.000000000000000000 USDT |");
  });

  it("refuses a malformed row rather than skip it", () => {
    expect(() => parseEvidence("| 1 | x | y | Mars | `t` | `p` | — | — | s |")).toThrow();
    expect(() => parseEvidence("| 1 | x | y | Base | `t` | `p` | 1.5 USDC | — | s |")).toThrow();
  });

  it("holds no signature, key or token", () => {
    expect(renderEvidence([])).not.toMatch(/ed25519:|eyJ|secret|signature/i);
  });
});

describe("Section 1 from the database", () => {
  async function seeded(
    mode: "live" | "simulated",
    status: "SUCCESS" | "REFUNDED",
    reconciled: boolean,
  ) {
    const { db, client } = await createTestDb();
    const seed = await seedLineItem(db, mode);
    await db
      .update(schema.payRunItems)
      .set({ amountUsdc: 50000n })
      .where(eq(schema.payRunItems.id, seed.itemId));
    await db.insert(schema.payoutAttempts).values({
      orgId: seed.orgId,
      lineItemId: seed.itemId,
      attemptNo: 1,
      status,
      mode,
      nearTxHashes: [NEAR_TX],
      destinationTxHash: BASE_TX,
      intentHash: "ih",
      terminalAt: new Date("2026-11-07T10:00:00.000Z"),
      reconciledAt: reconciled ? new Date("2026-11-07T10:01:00.000Z") : null,
    });
    const rows = await productEvidenceRows(db as never);
    await client.close();
    return rows;
  }

  it("includes a live, reconciled success: its NEAR side and its delivery", async () => {
    const rows = await seeded("live", "SUCCESS", true);
    expect(rows.map((r) => r.chain).sort()).toEqual(["base", "near"]);
    expect(rows.find((r) => r.chain === "base")?.amount?.units).toBe(50000n);
  });

  it("never includes a simulated record", async () => {
    expect(await seeded("simulated", "SUCCESS", true)).toEqual([]);
  });

  it("leaves out unreconciled and unsuccessful payouts", async () => {
    expect(await seeded("live", "SUCCESS", false)).toEqual([]);
    expect(await seeded("live", "REFUNDED", true)).toEqual([]);
  });
});
