"use client";
// "Link a NEAR wallet" for an account that signed up with email (slice W6). The wallet proves it is
// yours by signing one message the browser checks first (auth/link.ts); linking gives the email
// account a wallet to read balances with, and gives neither the email nor Veylo any key.
import { useState } from "react";
import { linkWallet } from "../auth/link";
import { Button } from "../ui/basic";
import { useSession } from "./session";
import { ErrorNote } from "./shell";
import { WalletPicker } from "./wallet-picker";

export function LinkWalletButton({
  onLinked,
  label = "Link a NEAR wallet",
}: {
  onLinked: () => void;
  label?: string;
}) {
  const { api, me, config, now, refreshMe } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function link(w: { signer: Parameters<typeof linkWallet>[0]["wallet"] }) {
    setBusy(true);
    setError(undefined);
    try {
      await linkWallet({
        api,
        wallet: w.signer,
        userId: me?.user.id ?? "",
        authRecipient: config.authRecipient,
        now,
      });
      await refreshMe();
      onLinked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't link the wallet. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Button variant="grey" onClick={() => setOpen(true)} disabled={busy}>
        {busy ? "Linking…" : label}
      </Button>
      {error ? <ErrorNote error={error} /> : null}
      <WalletPicker
        open={open}
        onClose={() => setOpen(false)}
        onConnected={link}
        title="Link a wallet to your account"
      />
    </div>
  );
}
