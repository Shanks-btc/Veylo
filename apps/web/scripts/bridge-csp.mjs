// The wallet bridge pages' CSPs (L44, W6). One page per wallet, so each page's policy names only
// that wallet's reviewed hosts (src/wallet/wallets.lock.json): looser than the app's where
// near-connect needs it (inline scripts and styles for the sandboxed wallet frame), strict where
// it matters: it can connect only to that wallet's hosts and NEAR RPC (never the Veylo API), and
// only the app origin may frame it. The Veylo wallet page (embedded) has no network access at all.

function dedupe(list) {
  return [...new Set(list)];
}

function assertNoApi(origins, apiOrigin) {
  if (apiOrigin && origins.includes(new URL(apiOrigin).origin)) {
    throw new Error("bridge CSP: the Veylo API origin must not be reachable from the bridge");
  }
}

/** A wallet entry from the lock: { allow: { connect, img, frame } }. */
export function bridgePolicy({ appOrigin, nearRpcUrl, apiOrigin, wallet }) {
  const rpc = new URL(nearRpcUrl).origin;
  const connect = dedupe([...wallet.allow.connect, rpc]);
  assertNoApi([...connect, ...wallet.allow.img, ...wallet.allow.frame], apiOrigin);
  const common = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${dedupe(["'self'", "data:", ...wallet.allow.img]).join(" ")}`,
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    `frame-src ${dedupe(["'self'", ...wallet.allow.frame]).join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  // frame-ancestors is ignored in a <meta> policy, so it goes in the header only.
  return {
    meta: common.join("; "),
    header: [...common, `frame-ancestors ${appOrigin}`].join("; "),
    connect,
  };
}

/**
 * The Veylo wallet page: the key is made and kept here, so the page may load nothing but its own
 * script and style, and connect nowhere (connect-src 'none'). No inline script or style either.
 */
export function embeddedPolicy({ appOrigin }) {
  const common = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  return {
    meta: common.join("; "),
    header: [...common, `frame-ancestors ${appOrigin}`].join("; "),
  };
}
