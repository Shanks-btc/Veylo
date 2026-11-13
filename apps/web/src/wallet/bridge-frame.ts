// The browser transport for the wallet bridge: one iframe of the bridge origin, shown as an
// overlay only while the wallet needs the person.
import type { BridgeTransport } from "./bridge-client";

export function createFrameTransport(bridgeOrigin: string, path = "/"): BridgeTransport {
  const frame = document.createElement("iframe");
  frame.src = `${bridgeOrigin}${path}`;
  frame.title = "Wallet";
  frame.className = "wallet-bridge";
  frame.hidden = true;
  frame.setAttribute("referrerpolicy", "no-referrer");
  // Only the Veylo wallet page may use passkeys, and only from inside this frame.
  frame.setAttribute("allow", "publickey-credentials-create; publickey-credentials-get");
  document.body.appendChild(frame);
  return {
    post: (message, targetOrigin) => frame.contentWindow?.postMessage(message, targetOrigin),
    listen(handler) {
      const fn = (e: MessageEvent) => handler({ origin: e.origin, source: e.source, data: e.data });
      window.addEventListener("message", fn);
      return () => window.removeEventListener("message", fn);
    },
    frameWindow: () => frame.contentWindow,
    show: (visible) => {
      frame.hidden = !visible;
    },
  };
}
