// The wallet bridge (L44): the app trusts nothing the bridge returns, and both sides ignore
// messages from anywhere but each other.
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";
import { hashNep413 } from "@veylo/intents";
import { describe, expect, it } from "vitest";
import { createBridgeHandler } from "../../bridge/handler";
import { createBridgeWallet, type BridgeTransport } from "./bridge-client";
import { BRIDGE_PROTOCOL, type BridgeRequest } from "./bridge-protocol";
import type { WalletSigner } from "./types";

const BRIDGE = "https://wallet.veylo.test";
const APP = "https://app.veylo.test";
const SECRET = new Uint8Array(32).fill(9);
const OTHER_SECRET = new Uint8Array(32).fill(4);
const keyOf = (secret: Uint8Array) => `ed25519:${base58.encode(ed25519.getPublicKey(secret))}`;
const KEY = keyOf(SECRET);
const OTHER_KEY = keyOf(OTHER_SECRET);
const ACCOUNT = "northwind.near";
const NONCE = new Uint8Array(32).fill(1);
const MSG = {
  message: "Sign in to Veylo\nAccount: northwind.near",
  recipient: "veylo.test",
  nonce: NONCE,
};

const sign = (secret: Uint8Array, m: { message: string; recipient: string; nonce: Uint8Array }) =>
  base64.encode(ed25519.sign(hashNep413(m), secret));

type Answer = (req: BridgeRequest) => Record<string, unknown> | undefined;

/** A fake bridge frame: each request is answered by `answer`, as a message from `origin`/`source`. */
function harness(opts: {
  answer: Answer;
  origin?: string;
  owns?: boolean;
  source?: "frame" | "other";
}) {
  const frame = {};
  const listeners: ((e: { origin: string; source: unknown; data: unknown }) => void)[] = [];
  const posted: BridgeRequest[] = [];
  const emit = (
    data: unknown,
    origin = opts.origin ?? BRIDGE,
    source: unknown = opts.source === "other" ? {} : frame,
  ) => listeners.forEach((l) => l({ origin, source, data }));
  const transport: BridgeTransport = {
    post(message, target) {
      expect(target).toBe(BRIDGE);
      posted.push(message);
      const body = opts.answer(message);
      if (body)
        queueMicrotask(() =>
          emit({ protocol: BRIDGE_PROTOCOL, requestId: message.requestId, ...body }),
        );
    },
    listen(h) {
      listeners.push(h);
      return () => {};
    },
    frameWindow: () => frame,
    show: () => {},
  };
  const wallet = createBridgeWallet({
    bridgeOrigin: BRIDGE,
    transport,
    rpc: { isAccountKey: async (a, k) => (opts.owns ?? true) && a === ACCOUNT && k === KEY },
    timeoutMs: 200,
  });
  // The real bridge announces itself first.
  emit({ protocol: BRIDGE_PROTOCOL, ready: true }, BRIDGE, frame);
  return { wallet, posted, emit, frame };
}

/** An honest bridge: connects as ACCOUNT/KEY and signs exactly the request. */
const honest: Answer = (req) =>
  req.kind === "connect"
    ? { accountId: ACCOUNT, publicKey: KEY }
    : req.kind === "signMessage"
      ? {
          accountId: ACCOUNT,
          publicKey: KEY,
          signature: sign(SECRET, {
            message: req.message,
            recipient: req.recipient,
            nonce: base64.decode(req.nonce),
          }),
        }
      : { error: "disconnected" };

describe("wallet bridge client", () => {
  it("accepts an honest bridge's signature over exactly the bytes it sent", async () => {
    const { wallet, posted } = harness({ answer: honest });
    await wallet.connect();
    const s = await wallet.signMessage(MSG);
    expect(s).toMatchObject({ accountId: ACCOUNT, publicKey: KEY });
    const req = posted.find((p) => p.kind === "signMessage");
    expect(req).toMatchObject({
      message: MSG.message,
      recipient: MSG.recipient,
      expectedAccountId: ACCOUNT,
      expectedPublicKey: KEY,
    });
  });

  it("rejects a forged signature", async () => {
    const { wallet } = harness({
      answer: (r) =>
        r.kind === "signMessage"
          ? {
              accountId: ACCOUNT,
              publicKey: KEY,
              signature: base64.encode(new Uint8Array(64).fill(7)),
            }
          : honest(r),
    });
    await wallet.connect();
    await expect(wallet.signMessage(MSG)).rejects.toThrow(/doesn't verify/);
  });

  it("rejects a signature by another key, even one that verifies for that key", async () => {
    const { wallet } = harness({
      answer: (r) =>
        r.kind === "signMessage"
          ? { accountId: ACCOUNT, publicKey: OTHER_KEY, signature: sign(OTHER_SECRET, MSG) }
          : honest(r),
    });
    await wallet.connect();
    await expect(wallet.signMessage(MSG)).rejects.toThrow(/another key/);
  });

  it("rejects a signature from another account", async () => {
    const { wallet } = harness({
      answer: (r) =>
        r.kind === "signMessage" ? { ...honest(r), accountId: "mallory.near" } : honest(r),
    });
    await wallet.connect();
    await expect(wallet.signMessage(MSG)).rejects.toThrow(/another account/);
  });

  it("rejects a signature over altered bytes", async () => {
    const { wallet } = harness({
      answer: (r) =>
        r.kind === "signMessage"
          ? {
              accountId: ACCOUNT,
              publicKey: KEY,
              signature: sign(SECRET, { ...MSG, message: `${MSG.message}\nPay to: mallory.near` }),
            }
          : honest(r),
    });
    await wallet.connect();
    await expect(wallet.signMessage(MSG)).rejects.toThrow(/doesn't verify/);
  });

  it("rejects a key that doesn't belong to the account (NEAR RPC says no)", async () => {
    const { wallet } = harness({ answer: honest, owns: false });
    await expect(wallet.connect()).rejects.toThrow(/doesn't belong/);
  });

  it("ignores answers from a foreign origin (and so times out)", async () => {
    const { wallet } = harness({ answer: honest, origin: "https://evil.example" });
    await expect(wallet.connect()).rejects.toThrow(/in time/);
  });

  it("ignores answers from the right origin but another window", async () => {
    const { wallet } = harness({ answer: honest, source: "other" });
    await expect(wallet.connect()).rejects.toThrow(/in time/);
  });

  it("ignores a replayed request id", async () => {
    const h = harness({ answer: honest });
    await h.wallet.connect();
    const first = await h.wallet.signMessage(MSG);
    const replayedId = h.posted.find((p) => p.kind === "signMessage")!.requestId;
    // A second sign request gets no honest answer; a replay of the first answer must not settle it.
    const second = { ...MSG, message: "Veylo payout\nAmount: 1" };
    const h2 = harness({ answer: (r) => (r.kind === "signMessage" ? undefined : honest(r)) });
    await h2.wallet.connect();
    const pending = h2.wallet.signMessage(second);
    h2.emit({
      protocol: BRIDGE_PROTOCOL,
      requestId: replayedId,
      accountId: ACCOUNT,
      publicKey: KEY,
      signature: first.signature,
    });
    await expect(pending).rejects.toThrow(/in time/);
  });

  it("ignores a response for another request", async () => {
    const h = harness({ answer: (r) => (r.kind === "signMessage" ? undefined : honest(r)) });
    await h.wallet.connect();
    const pending = h.wallet.signMessage(MSG);
    h.emit({
      protocol: BRIDGE_PROTOCOL,
      requestId: "zzzzzzzzzzzzzzzzzzzzzzzz",
      accountId: ACCOUNT,
      publicKey: KEY,
      signature: sign(SECRET, MSG),
    });
    await expect(pending).rejects.toThrow(/in time/);
  });

  it("an implicit account's own key needs no RPC call", async () => {
    const implicit = bytesToHex(ed25519.getPublicKey(SECRET));
    const h = harness({
      answer: (r) => (r.kind === "connect" ? { accountId: implicit, publicKey: KEY } : undefined),
      owns: false,
    });
    await expect(h.wallet.connect()).resolves.toMatchObject({ accountId: implicit });
  });
});

describe("wallet bridge page (bridge side)", () => {
  const parent = {
    sent: [] as unknown[],
    postMessage(m: unknown, o: string) {
      expect(o).toBe(APP);
      this.sent.push(m);
    },
  };
  const wallet: WalletSigner = {
    connect: async () => ({ accountId: ACCOUNT, publicKey: KEY }),
    signMessage: async () => ({ accountId: ACCOUNT, publicKey: KEY, signature: "sig" }),
    disconnect: async () => {},
  };
  const request = {
    protocol: BRIDGE_PROTOCOL,
    kind: "connect",
    requestId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  };

  it("answers the app origin's parent window", async () => {
    parent.sent = [];
    await createBridgeHandler({ appOrigin: APP, parent, wallet: async () => wallet })({
      origin: APP,
      source: parent,
      data: request,
    });
    expect(parent.sent).toEqual([
      {
        protocol: BRIDGE_PROTOCOL,
        requestId: request.requestId,
        accountId: ACCOUNT,
        publicKey: KEY,
      },
    ]);
  });

  it("ignores a foreign origin and a foreign window", async () => {
    parent.sent = [];
    const onMessage = createBridgeHandler({ appOrigin: APP, parent, wallet: async () => wallet });
    await onMessage({ origin: "https://evil.example", source: parent, data: request });
    await onMessage({ origin: APP, source: {}, data: request });
    expect(parent.sent).toEqual([]);
  });
});
