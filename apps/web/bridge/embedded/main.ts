// The Veylo wallet page (slice W6). Built by scripts/build-bridge.mjs into out-bridge/embedded/ and
// served from the wallet bridge origin. The key is made and kept here, protected by a passkey or a
// wallet password, and never leaves this page in plain form: the CSP says connect-src 'none', so
// this page cannot send anything anywhere, and the only message it posts is to the app that framed it.
import { BRIDGE_PROTOCOL } from "../../src/wallet/bridge-protocol";
import { createBridgeHandler } from "../handler";
import { createEmbeddedWallet } from "./flow";
import { indexedDbStore, memoryStore } from "./store";
import { createPrompt } from "./ui";
import { browserPasskeys } from "./webauthn";

declare const __APP_ORIGIN__: string;

const root = document.getElementById("root");
if (window.parent === window || !root) {
  document.body.textContent = "This page only works inside the Veylo app.";
} else {
  // Blocked storage (a private window, say) means a wallet can't be kept: say so, never pretend.
  const store = globalThis.indexedDB ? indexedDbStore() : memoryStore();
  const wallet = createEmbeddedWallet({
    store,
    passkeys: browserPasskeys(),
    prompt: createPrompt(root),
    random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    rpId: window.location.hostname,
  });
  const onMessage = createBridgeHandler({
    appOrigin: __APP_ORIGIN__,
    parent: window.parent,
    wallet: async () => wallet,
  });
  window.addEventListener("message", (e) => {
    void onMessage({ origin: e.origin, source: e.source, data: e.data });
  });
  window.parent.postMessage({ protocol: BRIDGE_PROTOCOL, ready: true }, __APP_ORIGIN__);
}
