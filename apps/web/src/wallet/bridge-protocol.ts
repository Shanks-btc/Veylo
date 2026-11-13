// The wallet bridge protocol (L44). The app (strict CSP, API access) and the bridge (its own origin,
// near-connect, no API access) talk only by postMessage, with exact origin checks on both sides.
// The bridge decides nothing: it asks the wallet to sign exactly what it's given and returns the
// wallet's answer. The app verifies every answer itself (src/wallet/bridge-client.ts).
import { z } from "zod";

export const BRIDGE_PROTOCOL = "veylo-wallet-bridge/1";

const requestId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

/** App → bridge. */
export const bridgeRequest = z.discriminatedUnion("kind", [
  z
    .object({
      protocol: z.literal(BRIDGE_PROTOCOL),
      kind: z.literal("connect"),
      requestId,
      /** Only the Veylo wallet page uses this: start by making or restoring a wallet. */
      intent: z.enum(["create", "restore"]).optional(),
    })
    .strict(),
  z
    .object({
      protocol: z.literal(BRIDGE_PROTOCOL),
      kind: z.literal("signMessage"),
      requestId,
      /** The NEP-413 fields, exactly as they'll be verified. */
      message: z.string().min(1).max(8192),
      recipient: z.string().min(1).max(128),
      /** base64 of exactly 32 bytes. */
      nonce: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
      expectedAccountId: z.string().min(1).max(64),
      expectedPublicKey: z.string().min(1).max(128).optional(),
    })
    .strict(),
  z
    .object({ protocol: z.literal(BRIDGE_PROTOCOL), kind: z.literal("disconnect"), requestId })
    .strict(),
  /** Only the Veylo wallet page: show the recovery phrase again, or add a second passkey. */
  z
    .object({
      protocol: z.literal(BRIDGE_PROTOCOL),
      kind: z.literal("manage"),
      requestId,
      action: z.enum(["export", "addPasskey"]),
    })
    .strict(),
]);
export type BridgeRequest = z.infer<typeof bridgeRequest>;

/** Bridge → app: only the request id and what the wallet returned, or an error. */
export const bridgeResponse = z.union([
  z
    .object({
      protocol: z.literal(BRIDGE_PROTOCOL),
      requestId,
      accountId: z.string().min(1).max(64),
      publicKey: z.string().max(128).optional(),
      signature: z.string().max(256).optional(),
    })
    .strict(),
  z
    .object({ protocol: z.literal(BRIDGE_PROTOCOL), requestId, error: z.string().max(300) })
    .strict(),
]);
export type BridgeResponse = z.infer<typeof bridgeResponse>;

/** The bridge says it's listening. */
export const bridgeReady = z
  .object({ protocol: z.literal(BRIDGE_PROTOCOL), ready: z.literal(true) })
  .strict();
