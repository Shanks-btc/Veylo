// The live privacy check (slice W5, C1): every load re-reads the payout's NEAR transactions from
// an archival node and works out what a stranger could connect. There is no cache and no stored
// verdict: if any transaction can't be read, the answer is "couldn't check right now".
import { PROOF_CASES, nearExplorerTx, type ProofCase } from "./cases";
import { mentions, publicTrail, type Party } from "./mentions";
import { finalSuccess, ProofUnavailable, type ProofRpc } from "./rpc";

export type TxFact = {
  readonly hash: string;
  readonly explorerUrl: string;
  readonly mentions: Record<Party, boolean>;
};

export type ProofResult =
  | {
      readonly status: "checked";
      readonly checkedAt: Date;
      readonly case: ProofCase;
      readonly txs: readonly TxFact[];
      readonly linked: boolean;
      readonly via: "none" | "same transaction" | "deposit address";
    }
  | {
      readonly status: "unavailable";
      readonly checkedAt: Date;
      readonly case: ProofCase;
      readonly reason: string;
    };

export async function checkProofCase(
  c: ProofCase,
  rpc: ProofRpc,
  now: () => Date,
): Promise<ProofResult> {
  try {
    const txs: TxFact[] = [];
    for (const hash of c.nearTxs) {
      const tx = await rpc.tx(hash);
      if (!finalSuccess(tx)) throw new ProofUnavailable("a transaction isn't final and successful");
      txs.push({ hash, explorerUrl: nearExplorerTx(hash), mentions: mentions(tx, c.ids) });
    }
    const trail = publicTrail(txs.map((t) => t.mentions));
    return { status: "checked", checkedAt: now(), case: c, txs, ...trail };
  } catch (err) {
    return {
      status: "unavailable",
      checkedAt: now(),
      case: c,
      reason: err instanceof ProofUnavailable ? err.message : "couldn't check right now",
    };
  }
}

export const checkAllProofCases = (rpc: ProofRpc, now: () => Date) =>
  Promise.all(PROOF_CASES.map((c) => checkProofCase(c, rpc, now)));
