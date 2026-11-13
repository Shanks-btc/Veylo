// Types for the parts of wallets-lib.mjs that tests use (slice W6). The rest is plain script code.
export declare function isLocalTarget(target: string): boolean;
export declare function withoutLocalOrigins<T extends { allowsOpen?: unknown }>(perms: T): T;
