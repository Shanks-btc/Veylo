// Reads one NEAR transaction from an archival node (read-only; no key, no cost). Old transactions
// are only on archival nodes. Anything but a final, successful answer is "unavailable": a failure
// to look is never reported as a result.
// Method: NEAR RPC "tx" (https://docs.near.org/api/rpc/transactions#transaction-status).
export type ProofRpc = { tx(hash: string): Promise<unknown> };

export class ProofUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofUnavailable";
  }
}

export function createProofRpc(options: {
  url: string;
  fetch: typeof globalThis.fetch;
  /** The account the transaction is looked up under: intents.near for NEAR Intents settlements. */
  senderAccountId?: string;
  timeoutMs?: number;
}): ProofRpc {
  return {
    async tx(hash) {
      let res: Response;
      try {
        res = await options.fetch(options.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tx",
            params: {
              tx_hash: hash,
              sender_account_id: options.senderAccountId ?? "intents.near",
              wait_until: "NONE",
            },
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        });
      } catch {
        throw new ProofUnavailable("couldn't reach NEAR RPC");
      }
      if (!res.ok) throw new ProofUnavailable(`NEAR RPC answered HTTP ${res.status}`);
      let body: { result?: unknown; error?: unknown };
      try {
        body = (await res.json()) as { result?: unknown; error?: unknown };
      } catch {
        throw new ProofUnavailable("NEAR RPC sent something unreadable");
      }
      if (!body.result) throw new ProofUnavailable("NEAR RPC has no such transaction");
      return body.result;
    },
  };
}

/** True only for a final, successful transaction. */
export function finalSuccess(tx: unknown): boolean {
  const t = tx as { status?: Record<string, unknown>; final_execution_status?: string };
  return (
    t.final_execution_status === "FINAL" &&
    typeof t.status === "object" &&
    t.status !== null &&
    ("SuccessValue" in t.status || "SuccessReceiptId" in t.status)
  );
}
