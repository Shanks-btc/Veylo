// Fixture tests for every enabled wallet (slice W6, part 2): sign-in, payee approval and payout
// signing each go through the same bridge client and the same app-side checks, whichever wallet
// answers. A wallet is simulated by a key of its own behind the real bridge protocol; the app
// verifies the signature over the exact bytes it sent, the key and the account, every time.
// These are fixtures, not live wallets: the live check with each real wallet is the founder's.
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { approvalExpiry, getPayoutRoute, type PayeeRecord } from "@veylo/core";
import {
  buildApprovalMessage,
  buildHeadMessage,
  hashNep413,
  payeeRecordHash,
  verifyNep413,
} from "@veylo/intents";
import { describe, expect, it } from "vitest";
import { signIn } from "../auth/sign-in";
import { checkApprovalRequest } from "../signing/payee-requests";
import { createBridgeWallet, type BridgeTransport } from "./bridge-client";
import { BRIDGE_PROTOCOL, type BridgeRequest } from "./bridge-protocol";
import { ENABLED_WALLETS, bridgePath } from "./registry";

const BRIDGE = "https://wallet.veylo.test";
const AUTH = "veylo.test";
const NOW = new Date("2026-11-12T10:00:00.000Z");

/** A fake wallet: its own key, answering the bridge protocol like the real bridge page would. */
function fakeWallet(
  id: string,
  opts: { signOver?: (r: Extract<BridgeRequest, { kind: "signMessage" }>) => Uint8Array },
) {
  const secret = sha256(new TextEncoder().encode(`veylo-test-wallet:${id}`));
  const pub = ed25519.getPublicKey(secret);
  const publicKey = `ed25519:${base58.encode(pub)}`;
  const accountId = bytesToHex(pub); // an implicit account, so the key owns it by construction
  const frame = {};
  const listeners: ((e: { origin: string; source: unknown; data: unknown }) => void)[] = [];
  const emit = (data: unknown) =>
    listeners.forEach((l) => l({ origin: BRIDGE, source: frame, data }));
  const posted: BridgeRequest[] = [];
  const transport: BridgeTransport = {
    post(message) {
      posted.push(message);
      let body: Record<string, unknown>;
      if (message.kind === "connect") body = { accountId, publicKey };
      else if (message.kind === "signMessage") {
        // What a wallet signs: NEP-413 over the exact fields it was given (or, in the attack
        // tests, over something else).
        const bytes =
          opts.signOver?.(message) ??
          hashNep413({
            message: message.message,
            recipient: message.recipient,
            nonce: base64.decode(message.nonce),
          });
        body = { accountId, publicKey, signature: base64.encode(ed25519.sign(bytes, secret)) };
      } else body = { error: "disconnected" };
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
    rpc: { isAccountKey: async () => false },
    timeoutMs: 500,
  });
  emit({ protocol: BRIDGE_PROTOCOL, ready: true });
  return { wallet, accountId, publicKey, posted };
}

/** The API's sign-in route, as far as the browser can tell: it serves a challenge and checks the answer. */
function fakeApi(accountOf: () => string) {
  const issued = new Map<string, string>();
  return {
    async call(route: string, input?: { body?: Record<string, string> }) {
      if (route === "POST /auth/challenge") {
        const nonce = new Uint8Array(32).fill(5);
        const accountId = input!.body!.accountId!;
        const message = [
          "Sign in to Veylo",
          `Account: ${accountId}`,
          `Nonce: ${bytesToHex(nonce)}`,
          `Issued: ${NOW.toISOString()}`,
          `Expires: ${new Date(NOW.getTime() + 5 * 60_000).toISOString()}`,
        ].join("\n");
        const b64 = base64.encode(nonce);
        issued.set(b64, message);
        return { message, nonce: b64, recipient: AUTH };
      }
      if (route === "POST /auth/verify") {
        const b = input!.body!;
        const message = issued.get(b.nonce!);
        if (!message) throw new Error("unknown challenge");
        const ok = verifyNep413({
          message,
          nonce: base64.decode(b.nonce!),
          recipient: AUTH,
          publicKey: b.publicKey!,
          signature: b.signature!,
        });
        if (!ok || b.accountId !== accountOf()) throw new Error("sign-in refused");
        return { accountId: b.accountId };
      }
      throw new Error(`unexpected ${route}`);
    },
  };
}

const ORG = "11111111-1111-4111-8111-111111111111";
const ADA = { id: "22222222-2222-4222-8222-222222222222", name: "Ada Lovelace" };
const DEST = "33333333-3333-4333-8333-333333333333";
function approvalRequest() {
  const route = getPayoutRoute("usdc-near-confidential");
  const approvedAt = new Date(NOW.getTime() - 60_000);
  const record: PayeeRecord = {
    orgId: ORG,
    contractorId: ADA.id,
    destinationId: DEST,
    routeId: route.id,
    recipient: "ada-l.near",
    recipientType: route.recipientType,
    version: 1,
    approvedAt,
    expiresAt: approvalExpiry(approvedAt),
  };
  return {
    approvalMessage: buildApprovalMessage({
      record,
      contractorName: ADA.name,
      routeLabel: route.label,
    }),
    approvalNonce: base64.encode(new Uint8Array(32).fill(7)),
    headMessage: buildHeadMessage({
      orgId: ORG,
      version: 1,
      recordHashes: [payeeRecordHash(record)],
      signedAt: NOW,
    }),
    headNonce: base64.encode(new Uint8Array(32).fill(8)),
    recipient: AUTH,
    record,
  };
}

describe.each(ENABLED_WALLETS.map((w) => [w.name, w] as const))("%s", (_name, w) => {
  it("is framed at its own bridge page", () => {
    expect(bridgePath(w.id)).toBe(`/w/${w.id}/`);
  });

  it("signs in: the challenge is checked, signed over the exact bytes, and verified", async () => {
    const { wallet, accountId } = fakeWallet(w.id, {});
    const api = fakeApi(() => accountId);
    const res = await signIn({ api: api as never, wallet, authRecipient: AUTH, now: () => NOW });
    expect(res.accountId).toBe(accountId);
  });

  it("approves a payee: the browser rebuilds the request, then the signature verifies", async () => {
    const { wallet, accountId } = fakeWallet(w.id, {});
    await wallet.connect();
    const req = approvalRequest();
    const checked = checkApprovalRequest(req, {
      orgId: ORG,
      authRecipient: AUTH,
      contractor: ADA,
      destination: { id: DEST, route: "usdc-near-confidential", address: "ada-l.near" },
      current: { version: 0, payees: [] },
      now: NOW,
    });
    expect(checked.recordHash).toBe(payeeRecordHash(req.record));
    const signed = await wallet.signMessage({
      message: req.approvalMessage,
      recipient: AUTH,
      nonce: base64.decode(req.approvalNonce),
    });
    expect(signed.accountId).toBe(accountId);
    expect(
      verifyNep413({
        message: req.approvalMessage,
        recipient: AUTH,
        nonce: base64.decode(req.approvalNonce),
        publicKey: signed.publicKey,
        signature: signed.signature,
      }),
    ).toBe(true);
  });

  it("signs a payout intent for the Intents verifier over the exact bytes", async () => {
    const { wallet } = fakeWallet(w.id, {});
    await wallet.connect();
    const message = JSON.stringify({
      signer_id: "northwind.near",
      deadline: "2026-11-12T10:15:00.000Z",
      intents: [
        { intent: "transfer", receiver_id: "deposit-address", tokens: { "nep141:usdc": "100000" } },
      ],
    });
    const nonce = new Uint8Array(32).fill(3);
    const signed = await wallet.signMessage({ message, recipient: "intents.far", nonce });
    expect(
      verifyNep413({
        message,
        recipient: "intents.far",
        nonce,
        publicKey: signed.publicKey,
        signature: signed.signature,
      }),
    ).toBe(true);
  });

  it("is refused when it signs different bytes than the app sent", async () => {
    const { wallet } = fakeWallet(w.id, {
      signOver: (r) =>
        hashNep413({
          message: `${r.message} (changed)`,
          recipient: r.recipient,
          nonce: base64.decode(r.nonce),
        }),
    });
    await wallet.connect();
    await expect(
      wallet.signMessage({
        message: "Pay 100 USDC to ada-l.near",
        recipient: AUTH,
        nonce: new Uint8Array(32).fill(1),
      }),
    ).rejects.toThrow(/doesn't verify/);
  });

  it("is refused when it signs a different recipient or nonce", async () => {
    for (const bump of ["recipient", "nonce"] as const) {
      const { wallet } = fakeWallet(w.id, {
        signOver: (r) =>
          hashNep413({
            message: r.message,
            recipient: bump === "recipient" ? "evil.near" : r.recipient,
            nonce: bump === "nonce" ? new Uint8Array(32).fill(9) : base64.decode(r.nonce),
          }),
      });
      await wallet.connect();
      await expect(
        wallet.signMessage({
          message: "hello",
          recipient: AUTH,
          nonce: new Uint8Array(32).fill(1),
        }),
      ).rejects.toThrow(/doesn't verify/);
    }
  });
});
