"use client";
// The wallet picker (slice W6, part 2): the Veylo wallet first (made in seconds, no app to install,
// only you hold the key), then every NEAR wallet that passed the checks in docs/WALLETS.md, with HOT
// and Meteor first. On a phone, wallets with an app come before browser extensions. Whatever the
// choice, the app verifies the signature over the exact bytes, the key and the account every time.
import { useEffect, useState } from "react";
import { isDemo } from "../demo/load";
import {
  EMBEDDED_ID,
  ENABLED_WALLETS,
  getAWalletLinks,
  kindLabel,
  pickerOrder,
  type WalletEntry,
} from "../wallet/registry";
import { Modal } from "../ui/interactive";
import { ErrorNote } from "./shell";
import { useSession, type ConnectedWallet } from "./session";

function WalletIcon({ wallet }: { wallet: WalletEntry }) {
  return wallet.icon ? (
    <img src={wallet.icon} alt="" width={36} height={36} loading="lazy" />
  ) : (
    <span className="picker-initial" aria-hidden="true">
      {wallet.name.slice(0, 1)}
    </span>
  );
}

export function WalletPicker({
  open,
  onClose,
  onConnected,
  title = "Choose a wallet",
}: {
  open: boolean;
  onClose: () => void;
  onConnected: (wallet: ConnectedWallet) => void;
  title?: string;
}) {
  const { connectWallet } = useSession();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    setMobile(window.matchMedia("(pointer: coarse)").matches);
  }, []);
  const wallets = pickerOrder(ENABLED_WALLETS, { mobile });

  async function pick(id: string, intent?: "create" | "restore") {
    setBusy(id + (intent ?? ""));
    setError(undefined);
    try {
      const w = await connectWallet(id, intent);
      onConnected(w);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect the wallet.");
    } finally {
      setBusy(undefined);
    }
  }

  // The demo has one stand-in wallet: no real wallet can work there, so none is offered.
  if (isDemo()) {
    return (
      <Modal open={open} title={title} onClose={onClose}>
        <div className="picker">
          <section className="stack" aria-labelledby="picker-demo">
            <h3 id="picker-demo">Demo wallet</h3>
            <p className="muted small">
              This demo has one stand-in wallet. It signs real messages with a throwaway key and
              moves no money.
            </p>
            <ul className="picker-list">
              <li>
                <button
                  type="button"
                  className="picker-item picker-first"
                  disabled={busy !== undefined}
                  onClick={() => pick("demo")}
                >
                  <span className="picker-initial" aria-hidden="true">
                    D
                  </span>
                  <span className="stack">
                    <span className="picker-name">
                      {busy === "demo" ? "Opening…" : "Use the demo wallet"}
                    </span>
                    <span className="picker-kind">Stand-in for a real NEAR wallet</span>
                  </span>
                </button>
              </li>
            </ul>
          </section>
          {error ? <ErrorNote error={error} /> : null}
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} title={title} onClose={onClose}>
      <div className="picker">
        <section className="stack" aria-labelledby="picker-veylo">
          <h3 id="picker-veylo">New here? Get a wallet in seconds</h3>
          <p className="muted small">
            No app to install. Only you hold the key; if you lose this device and your recovery
            phrase, Veylo can&apos;t recover it.
          </p>
          <ul className="picker-list">
            <li>
              <button
                type="button"
                className="picker-item picker-first"
                disabled={busy !== undefined}
                onClick={() => pick(EMBEDDED_ID, "create")}
              >
                <span className="picker-initial" aria-hidden="true">
                  V
                </span>
                <span className="stack">
                  <span className="picker-name">
                    {busy === `${EMBEDDED_ID}create` ? "Opening…" : "Create my Veylo wallet"}
                  </span>
                  <span className="picker-kind">
                    Protected by a passkey, with a recovery phrase
                  </span>
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="picker-item"
                disabled={busy !== undefined}
                onClick={() => pick(EMBEDDED_ID)}
              >
                <span className="picker-initial" aria-hidden="true">
                  V
                </span>
                <span className="stack">
                  <span className="picker-name">Use my Veylo wallet on this device</span>
                  <span className="picker-kind">Or restore it from your recovery phrase</span>
                </span>
              </button>
            </li>
          </ul>
        </section>

        <section className="stack" aria-labelledby="picker-existing">
          <h3 id="picker-existing">Connect an existing wallet</h3>
          <ul className="picker-list">
            {wallets.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className="picker-item"
                  disabled={busy !== undefined}
                  onClick={() => pick(w.id)}
                >
                  <WalletIcon wallet={w} />
                  <span className="stack">
                    <span className="picker-name">{busy === w.id ? "Opening…" : w.name}</span>
                    <span className="picker-kind">{kindLabel(w)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="stack" aria-labelledby="picker-get">
          <h3 id="picker-get">Need a wallet? Get one</h3>
          <ul className="picker-links">
            {getAWalletLinks().map((l) => (
              <li key={l.url}>
                <a href={l.url} rel="noopener noreferrer" target="_blank">
                  {l.name}
                </a>
              </li>
            ))}
          </ul>
        </section>
        {error ? <ErrorNote error={error} /> : null}
      </div>
    </Modal>
  );
}

/**
 * Renders the picker when some action (approving a payee, signing a payout) needs a wallet and none
 * is connected. Put it once inside every SessionProvider that can ask for a wallet.
 */
export function WalletPickerHost() {
  const { pickerOpen, finishPicker } = useSession();
  return (
    <WalletPicker
      open={pickerOpen}
      title="Connect your wallet to continue"
      onClose={() => finishPicker({ error: new Error("No wallet was chosen.") })}
      onConnected={(wallet) => finishPicker({ wallet })}
    />
  );
}
