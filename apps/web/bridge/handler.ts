// Bridge side of the wallet bridge (L44). Runs on its own origin, inside a frame of the app.
// It reads messages only from exactly the app origin and the parent window, asks the wallet to do
// exactly what was asked, and posts back only the request id and the wallet's answer. It decides
// nothing: the app verifies every signature, key and account itself.
import { base64 } from "@scure/base";
import { BRIDGE_PROTOCOL, bridgeRequest } from "../src/wallet/bridge-protocol";
import type { WalletSigner } from "../src/wallet/types";

export type BridgeEvent = { origin: string; source: unknown; data: unknown };

export function createBridgeHandler(options: {
  appOrigin: string;
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  wallet: () => Promise<WalletSigner>;
}) {
  const reply = (body: Record<string, unknown>) =>
    options.parent.postMessage({ protocol: BRIDGE_PROTOCOL, ...body }, options.appOrigin);

  return async function onMessage(event: BridgeEvent): Promise<void> {
    if (event.origin !== options.appOrigin) return;
    if (event.source !== options.parent) return;
    const parsed = bridgeRequest.safeParse(event.data);
    if (!parsed.success) return;
    const req = parsed.data;
    try {
      const wallet = await options.wallet();
      if (req.kind === "connect") {
        const a = await wallet.connect(req.intent);
        reply({
          requestId: req.requestId,
          accountId: a.accountId,
          ...(a.publicKey ? { publicKey: a.publicKey } : {}),
        });
      } else if (req.kind === "signMessage") {
        const s = await wallet.signMessage({
          message: req.message,
          recipient: req.recipient,
          nonce: base64.decode(req.nonce),
        });
        reply({
          requestId: req.requestId,
          accountId: s.accountId,
          publicKey: s.publicKey,
          signature: s.signature,
        });
      } else if (req.kind === "manage") {
        if (!wallet.manage) throw new Error("this wallet has nothing to manage here");
        const a = await wallet.manage(req.action);
        reply({ requestId: req.requestId, accountId: a.accountId });
      } else {
        await wallet.disconnect();
        reply({ requestId: req.requestId, error: "disconnected" });
      }
    } catch (err) {
      reply({
        requestId: req.requestId,
        error: (err instanceof Error ? err.message : "wallet error").slice(0, 300),
      });
    }
  };
}
