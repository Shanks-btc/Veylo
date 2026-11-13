// Types for bridge-csp.mjs: one CSP per wallet bridge page (slice W6).
export type WalletAllow = {
  connect: readonly string[];
  img: readonly string[];
  frame: readonly string[];
};
export declare function bridgePolicy(input: {
  appOrigin: string;
  nearRpcUrl: string;
  apiOrigin?: string;
  wallet: { allow: WalletAllow };
}): { meta: string; header: string; connect: string[] };
export declare function embeddedPolicy(input: { appOrigin: string }): {
  meta: string;
  header: string;
};
