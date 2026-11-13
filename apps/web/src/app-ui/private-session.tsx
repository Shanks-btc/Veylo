"use client";
// "Connect to read your private balance" (slice W6): opens a NEAR Intents session by having the wallet
// sign an EMPTY intent. The same flow serves the organisation's treasury (owner) and a contractor's
// own balance (portal). The browser checks the request first (gates/session.ts): anything that is not
// an empty intent for this wallet's own account is refused and the wallet is never asked. The
// session can only read balances; it cannot move money.
import { useState } from "react";
import { ApiError } from "../api/client";
import { checkSessionRequest } from "../gates/session";
import { Button } from "../ui/basic";
import { useSession } from "./session";
import { ErrorNote } from "./shell";

export type SessionKind =
  { type: "treasury"; orgId: string } | { type: "contractor"; contractorId: string };

export function PrivateSessionButton({
  kind,
  onOpened,
  label = "Connect to read my private balance",
}: {
  kind: SessionKind;
  onOpened: () => void;
  label?: string;
}) {
  const { api, connectWallet, now } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function open() {
    setBusy(true);
    setError(undefined);
    try {
      const wallet = await connectWallet();
      const call =
        kind.type === "treasury"
          ? {
              start: "POST /orgs/:orgId/treasury/session-request" as const,
              finish: "POST /orgs/:orgId/treasury/session-request/:id/complete" as const,
              params: { orgId: kind.orgId },
            }
          : {
              start: "POST /portal/contractors/:contractorId/session-request" as const,
              finish:
                "POST /portal/contractors/:contractorId/session-request/:id/complete" as const,
              params: { contractorId: kind.contractorId },
            };
      const req = await api.call(call.start, { params: call.params as never });
      const ok = checkSessionRequest(req.payload, { accountId: wallet.accountId, now: now() });
      if (!ok.ok) throw new Error(`Your wallet was not asked: ${ok.reason}.`);
      const signed = await wallet.signer.signMessage({
        message: req.payload.message,
        nonce: ok.nonce,
        recipient: req.payload.recipient,
      });
      if (signed.accountId !== wallet.accountId)
        throw new Error("The wallet signed as another account.");
      await api.call(call.finish, {
        params: { ...call.params, id: req.requestId } as never,
        body: {
          accountId: signed.accountId,
          publicKey: signed.publicKey,
          signature: signed.signature,
        },
      });
      onOpened();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "WALLET_REQUIRED"
            ? "Link a NEAR wallet to your account first. Your private balance lives on your wallet's account."
            : err.code === "WALLET_REJECTED" || err.code === "TREASURY_SIGNER_REJECTED"
              ? "That wallet isn't the account you signed in with. Connect the same wallet and try again."
              : err.message
          : err instanceof Error
            ? err.message
            : "Couldn't open the session. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Button onClick={() => void open()} disabled={busy}>
        {busy ? "Waiting for your wallet…" : label}
      </Button>
      <p className="small muted">
        Your wallet signs one empty message. It moves no funds, costs nothing, and only lets Veylo
        read this balance.
      </p>
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}
