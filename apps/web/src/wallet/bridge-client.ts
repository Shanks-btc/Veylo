// App side of the wallet bridge (L44). Implements WalletSigner over postMessage to the bridge
// frame, and trusts nothing it gets back:
//   only messages from exactly the bridge origin and the bridge frame's window are read;
//   a response must answer a request still pending (unknown, replayed or late ids are dropped);
//   a signature must verify (ed25519, NEP-413) over exactly the bytes the app sent;
//   the account must be the one expected, and the key the one expected;
//   the key must belong to the account: an implicit account's own key, or a full-access key that
//   NEAR RPC confirms. Any mismatch rejects.
import { base64 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parseEd25519PublicKey, verifyNep413 } from "@veylo/intents";
import {
  BRIDGE_PROTOCOL,
  bridgeReady,
  bridgeResponse,
  type BridgeRequest,
  type BridgeResponse,
} from "./bridge-protocol";
import type { WalletSigner } from "./types";

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

/** What the client needs from the page: injected, so tests can drive it without a browser. */
export type BridgeTransport = {
  /** Posts to the bridge frame, targeting exactly the bridge origin. */
  post(message: BridgeRequest, targetOrigin: string): void;
  /** Subscribes to window "message" events. */
  listen(handler: (event: { origin: string; source: unknown; data: unknown }) => void): () => void;
  /** The bridge frame's window, compared by identity with event.source. */
  frameWindow(): unknown;
  /** Makes the bridge frame visible while the wallet needs the person (and hides it after). */
  show(visible: boolean): void;
};

export type KeyOwnership = {
  /** NEAR RPC: is this a full-access key of the account? */
  isAccountKey(accountId: string, publicKey: string): Promise<boolean>;
};

const IMPLICIT = /^[0-9a-f]{64}$/;

export async function keyBelongsTo(
  accountId: string,
  publicKey: string,
  rpc: KeyOwnership,
): Promise<boolean> {
  const key = parseEd25519PublicKey(publicKey);
  if (!key) return false;
  if (IMPLICIT.test(accountId)) return bytesToHex(key) === accountId;
  return rpc.isAccountKey(accountId, publicKey);
}

function newRequestId(random: (n: number) => Uint8Array): string {
  return base64.encode(random(24)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createBridgeWallet(options: {
  bridgeOrigin: string;
  transport: BridgeTransport;
  rpc: KeyOwnership;
  random?: (n: number) => Uint8Array;
  timeoutMs?: number;
}): WalletSigner & { close(): void } {
  const bridgeOrigin = new URL(options.bridgeOrigin).origin;
  if (bridgeOrigin !== options.bridgeOrigin)
    throw new BridgeError("bridge origin must be an origin");
  const random = options.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const pending = new Map<string, (r: BridgeResponse) => void>();
  let readyResolve: () => void = () => {};
  let ready = new Promise<void>((ok) => (readyResolve = ok));
  let connected: { accountId: string; publicKey?: string } | undefined;

  const stop = options.transport.listen((event) => {
    // Exact origin and the bridge frame itself; everything else is ignored.
    if (event.origin !== bridgeOrigin) return;
    if (event.source !== options.transport.frameWindow()) return;
    if (bridgeReady.safeParse(event.data).success) {
      readyResolve();
      return;
    }
    const parsed = bridgeResponse.safeParse(event.data);
    if (!parsed.success) return;
    const settle = pending.get(parsed.data.requestId);
    if (!settle) return; // Unknown, replayed or late: dropped.
    pending.delete(parsed.data.requestId);
    settle(parsed.data);
  });

  async function send(request: BridgeRequest): Promise<BridgeResponse> {
    await ready;
    options.transport.show(true);
    try {
      return await new Promise<BridgeResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.requestId);
          reject(new BridgeError("the wallet didn't answer in time"));
        }, timeoutMs);
        pending.set(request.requestId, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        options.transport.post(request, bridgeOrigin);
      });
    } finally {
      if (pending.size === 0) options.transport.show(false);
    }
  }

  const failIfError = (r: BridgeResponse) => {
    if ("error" in r) throw new BridgeError(`wallet: ${r.error}`);
    return r;
  };

  return {
    async connect(intent) {
      const r = failIfError(
        await send({
          protocol: BRIDGE_PROTOCOL,
          kind: "connect",
          requestId: newRequestId(random),
          ...(intent ? { intent } : {}),
        }),
      );
      if (r.signature !== undefined) throw new BridgeError("unexpected signature on connect");
      if (r.publicKey !== undefined && !(await keyBelongsTo(r.accountId, r.publicKey, options.rpc)))
        throw new BridgeError("the wallet's key doesn't belong to its account");
      connected = r.publicKey
        ? { accountId: r.accountId, publicKey: r.publicKey }
        : { accountId: r.accountId };
      return connected;
    },

    async signMessage({ message, recipient, nonce }) {
      if (!connected) throw new BridgeError("connect the wallet first");
      if (nonce.length !== 32) throw new BridgeError("the nonce must be 32 bytes");
      const expected = connected;
      const r = failIfError(
        await send({
          protocol: BRIDGE_PROTOCOL,
          kind: "signMessage",
          requestId: newRequestId(random),
          message,
          recipient,
          nonce: base64.encode(nonce),
          expectedAccountId: expected.accountId,
          ...(expected.publicKey ? { expectedPublicKey: expected.publicKey } : {}),
        }),
      );
      if (!r.publicKey || !r.signature) throw new BridgeError("the wallet returned no signature");
      if (r.accountId !== expected.accountId)
        throw new BridgeError("the wallet signed as another account");
      if (expected.publicKey && r.publicKey !== expected.publicKey)
        throw new BridgeError("the wallet signed with another key");
      // Exactly the bytes this app sent: its own message, recipient and nonce, not anything echoed.
      if (
        !verifyNep413({ message, recipient, nonce, publicKey: r.publicKey, signature: r.signature })
      )
        throw new BridgeError("the signature doesn't verify");
      if (!(await keyBelongsTo(r.accountId, r.publicKey, options.rpc)))
        throw new BridgeError("the signing key doesn't belong to the account");
      return { accountId: r.accountId, publicKey: r.publicKey, signature: r.signature };
    },

    async manage(action) {
      if (!connected) throw new BridgeError("connect the wallet first");
      const r = failIfError(
        await send({
          protocol: BRIDGE_PROTOCOL,
          kind: "manage",
          requestId: newRequestId(random),
          action,
        }),
      );
      if (r.accountId !== connected.accountId)
        throw new BridgeError("the wallet answered for another account");
      return { accountId: r.accountId };
    },

    async disconnect() {
      connected = undefined;
      await send({
        protocol: BRIDGE_PROTOCOL,
        kind: "disconnect",
        requestId: newRequestId(random),
      }).catch(() => undefined);
    },

    close() {
      stop();
      for (const [id] of pending) pending.delete(id);
      ready = Promise.reject(new BridgeError("closed"));
      ready.catch(() => undefined);
    },
  };
}
