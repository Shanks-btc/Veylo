"use client";
// "What the public sees" (slice W5, C1): the same payout seen two ways. Both columns are computed
// live, on every load, from NEAR mainnet (read-only archival RPC): nothing is cached, and if the
// chain can't be read the screen says "couldn't check right now" rather than showing a verdict.
// Sources: the recorded Phase 2 payouts in docs/EVIDENCE.md; method: NEAR RPC "tx"
// (https://docs.near.org/api/rpc/transactions#transaction-status).
import { useCallback, useEffect, useState } from "react";
import { baseExplorerTx, PROOF_CASES, type ProofCase } from "../proof/cases";
import { checkProofCase, type ProofResult } from "../proof/check";
import { createProofRpc } from "../proof/rpc";
import { PRIVACY_CONDITION } from "../site";
import { webConfig } from "../app-ui/session";
import { Button, Tag } from "../ui/basic";
import { Card } from "../ui/card";

const short = (h: string) => `${h.slice(0, 8)}…`;
const yes = (b: boolean) => (b ? "yes" : "no");

function Column({
  c,
  result,
  onRetry,
}: {
  c: ProofCase;
  result: ProofResult | undefined;
  onRetry: () => void;
}) {
  const isPrivate = c.kind === "private";
  return (
    <Card size="lg" className="proof-col">
      <div className="spread">
        <h2 className="section-title">{isPrivate ? "Private" : "Direct"}</h2>
        {isPrivate ? <Tag tone="private">Private</Tag> : <Tag tone="direct">Direct</Tag>}
      </div>
      <p className="muted small">
        {c.title}. Recorded in {c.evidence}.
      </p>
      {!result ? (
        <p role="status">Reading NEAR mainnet…</p>
      ) : result.status === "unavailable" ? (
        <div className="stack" role="alert">
          <p>
            <strong>Couldn&apos;t check right now.</strong> {result.reason}.
          </p>
          <Button variant="grey" small onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <p>
            {result.linked ? (
              <strong>A stranger can follow the money from the treasury to the recipient.</strong>
            ) : (
              <strong>No public transaction we read links the treasury to the recipient.</strong>
            )}{" "}
            {result.linked
              ? result.via === "deposit address"
                ? "The treasury and the payout's deposit address appear together in a transaction, and so do the deposit address and the recipient."
                : "The treasury and the recipient appear in the same transaction."
              : "The treasury isn't named in any of this payout's NEAR transactions."}
          </p>
          <table className="table proof-table">
            <caption className="sr-only">NEAR transactions read for this payout</caption>
            <thead>
              <tr>
                <th scope="col">Transaction</th>
                <th scope="col">Names the treasury</th>
                <th scope="col">Names the deposit address</th>
                <th scope="col">Names the recipient</th>
              </tr>
            </thead>
            <tbody>
              {result.txs.map((t) => (
                <tr key={t.hash}>
                  <td data-label="Transaction">
                    <a href={t.explorerUrl} target="_blank" rel="noopener noreferrer">
                      {short(t.hash)}
                      <span className="sr-only"> (opens the NEAR explorer in a new tab)</span>
                    </a>
                  </td>
                  <td data-label="Names the treasury">{yes(t.mentions.treasury)}</td>
                  <td data-label="Names the deposit address">{yes(t.mentions.deposit)}</td>
                  <td data-label="Names the recipient">{yes(t.mentions.recipient)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">
            Delivery on {c.deliveryTx.chain}:{" "}
            <a href={baseExplorerTx(c.deliveryTx.hash)} target="_blank" rel="noopener noreferrer">
              {short(c.deliveryTx.hash)}
              <span className="sr-only"> (opens the block explorer in a new tab)</span>
            </a>
            . Checked at{" "}
            <time dateTime={result.checkedAt.toISOString()}>
              {result.checkedAt.toISOString().replace("T", " ").slice(0, 19)} UTC
            </time>
            .
          </p>
        </>
      )}
      {isPrivate ? <p className="notice notice-private small">{PRIVACY_CONDITION}</p> : null}
    </Card>
  );
}

export function PrivacyProofView() {
  const [results, setResults] = useState<Record<string, ProofResult | undefined>>({});
  const run = useCallback(async () => {
    setResults({});
    const rpc = createProofRpc({
      url: webConfig.nearArchivalRpcUrl,
      fetch: globalThis.fetch.bind(globalThis),
    });
    await Promise.all(
      PROOF_CASES.map(async (c) => {
        const r = await checkProofCase(c, rpc, () => new Date());
        setResults((prev) => ({ ...prev, [c.id]: r }));
      }),
    );
  }, []);
  useEffect(() => {
    void run();
  }, [run]);
  return (
    <div className="stack">
      <p className="muted">
        The same kind of payout, seen by a stranger on NEAR mainnet. These are real payouts from our
        mainnet tests; every load reads the transactions again.
      </p>
      <div className="grid-2">
        {PROOF_CASES.map((c) => (
          <Column key={c.id} c={c} result={results[c.id]} onRetry={run} />
        ))}
      </div>
      <Button variant="grey" small onClick={run}>
        Check again
      </Button>
    </div>
  );
}
