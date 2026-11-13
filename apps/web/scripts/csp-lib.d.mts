// Types for csp-lib.mjs, the post-build CSP step.
export declare function inspectHtml(html: string, file?: string): string[];
export declare function buildPolicy(input: {
  apiOrigin: string;
  nearRpcUrl: string;
  archivalRpcUrl?: string;
  bridgeOrigin: string;
  scriptHashes: readonly string[];
}): string;
export declare function assertOrigins(origins: readonly string[], local?: boolean): void;
export declare function applyPolicy(html: string, policy: string, file?: string): string;
export declare function deferHydration(html: string): string;
