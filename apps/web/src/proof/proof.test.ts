// Privacy proof (C1) and verify-payout (C2), against recorded mainnet RPC answers (docs/EVIDENCE.md
// payouts). No network: the recorded transactions are served from fixtures.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROOF_CASES } from "./cases";
import { checkProofCase } from "./check";
import { mentions, publicTrail } from "./mentions";
import { createProofRpc, ProofUnavailable, type ProofRpc } from "./rpc";
import { verifyDirectPayout } from "./verify";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/rpc-${name}.json`, import.meta.url), "utf8")) as {
    transaction: { hash: string };
  };
const BY_HASH = new Map(
  ["c2-12CP8DF7", "c2-2M4rSw8w", "c2-7Mm6ctWX", "c2-8rWKiads", "t5b-4cSR3khu", "t5b-NYxGcFad"].map(
    (n) => {
      const f = fixture(n);
      return [f.transaction.hash, f] as const;
    },
  ),
);
const NOW = new Date("2026-11-12T09:00:00.000Z");

function recorded(over: (hash: string, tx: unknown) => unknown = (_h, tx) => tx) {
  const calls: string[] = [];
  const rpc: ProofRpc = {
    async tx(hash) {
      calls.push(hash);
      const tx = BY_HASH.get(hash);
      if (!tx) throw new ProofUnavailable("NEAR RPC has no such transaction");
      return over(hash, structuredClone(tx));
    },
  };
  return { rpc, calls };
}
const direct = PROOF_CASES.find((c) => c.id === "direct")!;
const priv = PROOF_CASES.find((c) => c.id === "private")!;

describe("what the public sees (C1)", () => {
  it("direct payout: a stranger can follow treasury → deposit address → recipient", async () => {
    const { rpc } = recorded();
    const r = await checkProofCase(direct, rpc, () => NOW);
    expect(r).toMatchObject({ status: "checked", linked: true, via: "deposit address" });
    if (r.status !== "checked") return;
    expect(r.txs.some((t) => t.mentions.treasury && t.mentions.deposit)).toBe(true);
    expect(r.txs.some((t) => t.mentions.deposit && t.mentions.recipient)).toBe(true);
  });

  it("private payout: no transaction names the treasury, so no trail is found", async () => {
    const { rpc, calls } = recorded();
    const r = await checkProofCase(priv, rpc, () => NOW);
    expect(r).toMatchObject({ status: "checked", linked: false, via: "none" });
    if (r.status !== "checked") return;
    expect(r.txs.every((t) => !t.mentions.treasury)).toBe(true);
    // It really looked: every transaction was read from the node, none skipped.
    expect(calls).toEqual([...priv.nearTxs]);
  });

  it("private payout: if a transaction did name the treasury and recipient, the link is reported", async () => {
    const { rpc } = recorded((hash, tx) => {
      if (hash !== priv.nearTxs[1]) return tx;
      (tx as { injected?: string }).injected = `${priv.ids.treasury} ${priv.ids.recipient}`;
      return tx;
    });
    const r = await checkProofCase(priv, rpc, () => NOW);
    expect(r).toMatchObject({ status: "checked", linked: true, via: "same transaction" });
  });

  it("an RPC failure is 'couldn't check', never a pass", async () => {
    const down: ProofRpc = {
      tx: () => Promise.reject(new ProofUnavailable("couldn't reach NEAR RPC")),
    };
    for (const c of PROOF_CASES) {
      const r = await checkProofCase(c, down, () => NOW);
      expect(r).toMatchObject({ status: "unavailable", reason: "couldn't reach NEAR RPC" });
      expect("linked" in r).toBe(false);
    }
  });

  it("a transaction that isn't final and successful makes the check unavailable", async () => {
    const { rpc } = recorded((_h, tx) => ({
      ...(tx as object),
      final_execution_status: "INCLUDED",
    }));
    expect((await checkProofCase(priv, rpc, () => NOW)).status).toBe("unavailable");
    const { rpc: failed } = recorded((_h, tx) => ({ ...(tx as object), status: { Failure: {} } }));
    expect((await checkProofCase(priv, failed, () => NOW)).status).toBe("unavailable");
  });

  it("checkedAt is when the check ran, and nothing is cached between runs", async () => {
    const { rpc, calls } = recorded();
    await checkProofCase(priv, rpc, () => NOW);
    await checkProofCase(priv, rpc, () => new Date("2026-11-12T09:05:00.000Z"));
    expect(calls).toHaveLength(priv.nearTxs.length * 2);
  });

  it("the trail rule: both hops must be named", () => {
    const m = (treasury: boolean, deposit: boolean, recipient: boolean) => ({
      treasury,
      deposit,
      recipient,
    });
    expect(publicTrail([m(true, true, false), m(false, true, true)]).linked).toBe(true);
    expect(publicTrail([m(true, true, false)]).linked).toBe(false);
    expect(publicTrail([m(false, true, true)]).linked).toBe(false);
    expect(publicTrail([m(true, false, true)])).toEqual({ linked: true, via: "same transaction" });
    expect(publicTrail([])).toEqual({ linked: false, via: "none" });
  });

  it("matching is on the transaction's public data, including decoded call arguments", () => {
    const args = Buffer.from(JSON.stringify({ signer_id: priv.ids.treasury })).toString("base64");
    const tx = { transaction: { actions: [{ FunctionCall: { args } }] } };
    expect(mentions(tx, priv.ids).treasury).toBe(true);
    expect(mentions({ transaction: {} }, priv.ids).treasury).toBe(false);
  });

  it("createProofRpc reports every failure as unavailable", async () => {
    const mk = (f: typeof fetch) => createProofRpc({ url: "https://archive.test", fetch: f });
    await expect(mk(() => Promise.reject(new Error("net"))).tx("x")).rejects.toBeInstanceOf(
      ProofUnavailable,
    );
    await expect(mk(async () => new Response("", { status: 429 })).tx("x")).rejects.toBeInstanceOf(
      ProofUnavailable,
    );
    await expect(mk(async () => new Response("not json")).tx("x")).rejects.toBeInstanceOf(
      ProofUnavailable,
    );
    await expect(
      mk(async () => new Response(JSON.stringify({ error: { name: "HANDLER_ERROR" } }))).tx("x"),
    ).rejects.toBeInstanceOf(ProofUnavailable);
  });
});

describe("verify payout (C2)", () => {
  const input = (over: Partial<Parameters<typeof verifyDirectPayout>[0]> = {}) => ({
    nearTxHashes: direct.nearTxs,
    payslipRecipient: direct.ids.recipient,
    payslipAmountUnits: direct.amountUnits,
    deliveryFeeUnits: "2400",
    approvedRecipient: direct.ids.recipient,
    rpc: recorded().rpc,
    now: () => NOW,
    ...over,
  });

  it("verifies a direct payout from the recorded NEAR transactions", async () => {
    const r = await verifyDirectPayout(input());
    expect(r.status).toBe("verified");
    if (r.status === "unavailable") return;
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("an amount that differs from the payslip fails, even by one unit", async () => {
    const r = await verifyDirectPayout(input({ payslipAmountUnits: "500001" }));
    expect(r.status).toBe("failed");
    expect((await verifyDirectPayout(input({ deliveryFeeUnits: "2401" }))).status).toBe("failed");
    expect(r.status).toBe("failed");
    if (r.status === "unavailable") return;
    expect(r.checks.find((c) => c.label.startsWith("The amount"))?.ok).toBe(false);
  });

  it("a recipient that isn't the approved payee fails", async () => {
    expect(
      (
        await verifyDirectPayout(
          input({ approvedRecipient: "0x0000000000000000000000000000000000000001" }),
        )
      ).status,
    ).toBe("failed");
    expect((await verifyDirectPayout(input({ approvedRecipient: undefined }))).status).toBe(
      "failed",
    );
  });

  it("a recipient the transactions never name fails", async () => {
    const other = "0x0000000000000000000000000000000000000002";
    expect(
      (await verifyDirectPayout(input({ payslipRecipient: other, approvedRecipient: other })))
        .status,
    ).toBe("failed");
  });

  it("no recorded transaction, or an unreadable one, is unavailable", async () => {
    expect((await verifyDirectPayout(input({ nearTxHashes: [] }))).status).toBe("unavailable");
    expect((await verifyDirectPayout(input({ nearTxHashes: ["not-recorded"] }))).status).toBe(
      "unavailable",
    );
  });
});
