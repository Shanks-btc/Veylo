// The wallet bridge page for one external wallet (L44, W6). Built by scripts/build-bridge.mjs into
// out-bridge/w/<wallet id>/, served from its own origin (docs/DEPLOY.md), each with its own CSP that
// names only that wallet's reviewed hosts. It never talks to the Veylo API: its CSP doesn't allow it.
import { BRIDGE_PROTOCOL } from "../src/wallet/bridge-protocol";
import { createNearConnectWallet } from "../src/wallet/near-connect";
import type { WalletSigner } from "../src/wallet/types";
import { createBridgeHandler } from "./handler";

declare const __APP_ORIGIN__: string;
declare const __NEAR_RPC_URL__: string;

const walletId = document.documentElement.dataset.wallet ?? "";

if (window.parent === window) {
  document.body.textContent = "This page only works inside the Veylo app.";
} else if (!walletId) {
  document.body.textContent = "No wallet selected.";
} else {
  let wallet: Promise<WalletSigner> | undefined;
  const onMessage = createBridgeHandler({
    appOrigin: __APP_ORIGIN__,
    parent: window.parent,
    wallet: () => (wallet ??= createNearConnectWallet({ rpcUrl: __NEAR_RPC_URL__, walletId })),
  });
  window.addEventListener("message", (e) => {
    void onMessage({ origin: e.origin, source: e.source, data: e.data });
  });
  window.parent.postMessage({ protocol: BRIDGE_PROTOCOL, ready: true }, __APP_ORIGIN__);
}
