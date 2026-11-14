// Build-time settings for the static web app. Next.js inlines NEXT_PUBLIC_* at build, so these are
// public by design: no secret may ever be one. The CSP script reads the same values.
import { z } from "zod";

const origin = z.string().refine((v) => {
  try {
    return new URL(v).origin === v;
  } catch {
    return false;
  }
}, "must be an origin, with no path");

export const webConfigSchema = z.object({
  /** The API's origin, such as https://api.veylo.app. Same site as the web app (L23). */
  apiOrigin: origin,
  /**
   * A path the API is served under on that origin (W7), such as /api, or none. The hosted web
   * origin forwards it to the API so the sign-in cookie stays first-party.
   */
  apiBasePath: z.string().regex(/^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*$/),
  /** NEAR RPC, called straight from the browser by the gates (T-2), never via the API. */
  nearRpcUrl: z.string().regex(/^https:\/\/\S+$/),
  /** Archival NEAR RPC, read-only, for the proof and verify pages (old transactions). */
  nearArchivalRpcUrl: z.string().regex(/^https:\/\/\S+$/),
  /** What wallets sign for: the API's AUTH_RECIPIENT. */
  authRecipient: z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/),
  /** The wallet bridge's origin (L44), e.g. https://wallet.veylo.app. Never the API origin. */
  walletBridgeOrigin: origin,
  /** The API's PAYOUT_QUOTE_DEADLINE_MINUTES (L35). */
  payoutQuoteDeadlineMinutes: z.coerce.number().int().min(1).max(60),
});
export type WebConfig = z.infer<typeof webConfigSchema>;

export function loadWebConfig(env: Record<string, string | undefined>): WebConfig {
  return webConfigSchema.parse({
    apiOrigin: env.NEXT_PUBLIC_API_ORIGIN,
    apiBasePath: env.NEXT_PUBLIC_API_BASE_PATH ?? "",
    nearRpcUrl: env.NEXT_PUBLIC_NEAR_RPC_URL ?? "https://rpc.fastnear.com",
    nearArchivalRpcUrl:
      env.NEXT_PUBLIC_NEAR_ARCHIVAL_RPC_URL ?? "https://archival-rpc.mainnet.fastnear.com",
    walletBridgeOrigin: env.NEXT_PUBLIC_WALLET_BRIDGE_ORIGIN,
    authRecipient: env.NEXT_PUBLIC_AUTH_RECIPIENT,
    payoutQuoteDeadlineMinutes: env.NEXT_PUBLIC_PAYOUT_QUOTE_DEADLINE_MINUTES ?? "15",
  });
}
