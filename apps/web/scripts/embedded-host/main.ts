// A stand-in for the app, for the Veylo wallet's browser check (scripts/embedded-e2e.mjs). It is
// served from its own origin and uses the app's REAL bridge client and frame transport, so the wallet
// page is driven over the real postMessage protocol from a different origin, exactly as in the app.
import { createBridgeWallet } from "../../src/wallet/bridge-client";
import { createFrameTransport } from "../../src/wallet/bridge-frame";

declare const __BRIDGE_ORIGIN__: string;

const seen: string[] = [];
window.addEventListener("message", (e) => {
  seen.push(JSON.stringify({ origin: e.origin, data: e.data }));
});

const wallet = createBridgeWallet({
  bridgeOrigin: __BRIDGE_ORIGIN__,
  transport: createFrameTransport(__BRIDGE_ORIGIN__, "/embedded/"),
  // An implicit account is its own key, so no NEAR RPC is needed to check ownership.
  rpc: { isAccountKey: async () => false },
  timeoutMs: 120_000,
});

Object.assign(window, { host: { wallet, seen } });
