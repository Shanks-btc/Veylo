import { parseEd25519PublicKey } from "@veylo/intents";
import { z } from "zod";

export class NearRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NearRpcError";
  }
}

export type AccessKeyPermission = "full_access" | "function_call";

export type NearRpc = {
  /** false means the account doesn't exist on-chain: an implicit account that was never funded. */
  viewAccount(accountId: string): Promise<boolean>;
  /** undefined means the key isn't on the account, or the account doesn't exist. */
  viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyPermission | undefined>;
  viewAccessKeyList(
    accountId: string,
  ): Promise<readonly { publicKey: string; permission: AccessKeyPermission }[]>;
};

const permission = z
  .union([z.literal("FullAccess"), z.object({ FunctionCall: z.unknown() })])
  .transform((p): AccessKeyPermission => (p === "FullAccess" ? "full_access" : "function_call"));

const account = z.object({ amount: z.string() });
const accessKey = z.object({ permission });
const accessKeyList = z.object({
  keys: z.array(z.object({ public_key: z.string(), access_key: accessKey })),
});

/**
 * A key that isn't there arrives as `result.error` with text (seen live on rpc.fastnear.com,
 * 2026-11-06). Newer nodes may use `error.cause.name`, so both are handled.
 */
const NOT_FOUND = new Set(["UNKNOWN_ACCESS_KEY", "UNKNOWN_ACCOUNT"]);
const NOT_FOUND_TEXT = /does not exist while viewing/;

export function createNearRpc(options: {
  url: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}): NearRpc {
  const timeoutMs = options.timeoutMs ?? 5_000;

  async function query(params: Record<string, string>): Promise<unknown | undefined> {
    let body: unknown;
    try {
      const response = await options.fetch(options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "veylo",
          method: "query",
          params: { finality: "final", ...params },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new NearRpcError(`NEAR RPC returned HTTP ${response.status}`);
      body = await response.json();
    } catch (err) {
      if (err instanceof NearRpcError) throw err;
      throw new NearRpcError("NEAR RPC request failed or timed out");
    }
    const parsed = z
      .object({
        result: z.looseObject({ error: z.string().optional() }).optional(),
        error: z.looseObject({ cause: z.object({ name: z.string() }).optional() }).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new NearRpcError("NEAR RPC returned an unexpected response");
    const { result, error } = parsed.data;
    if (error) {
      if (NOT_FOUND.has(error.cause?.name ?? "")) return undefined;
      throw new NearRpcError(`NEAR RPC error ${error.cause?.name ?? "unknown"}`);
    }
    if (!result) throw new NearRpcError("NEAR RPC returned no result");
    if (result.error !== undefined) {
      if (NOT_FOUND_TEXT.test(result.error)) return undefined;
      throw new NearRpcError("NEAR RPC query failed");
    }
    return result;
  }

  function shape<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new NearRpcError("NEAR RPC returned an unexpected response");
    return parsed.data;
  }

  return {
    async viewAccount(accountId) {
      const result = await query({ request_type: "view_account", account_id: accountId });
      if (result === undefined) return false;
      shape(account, result);
      return true;
    },
    async viewAccessKey(accountId, publicKey) {
      const result = await query({
        request_type: "view_access_key",
        account_id: accountId,
        public_key: publicKey,
      });
      return result === undefined ? undefined : shape(accessKey, result).permission;
    },
    async viewAccessKeyList(accountId) {
      const result = await query({ request_type: "view_access_key_list", account_id: accountId });
      if (result === undefined) return [];
      return shape(accessKeyList, result).keys.map((k) => ({
        publicKey: k.public_key,
        permission: k.access_key.permission,
      }));
    },
  };
}

const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

/**
 * An account that exists on-chain, named or implicit: the key must be a FullAccess key per RPC, so
 * a rotated-out key stops working.
 * An implicit account that doesn't exist yet has no keys to ask about: the key must derive its ID.
 * RPC failures throw, so a caller can only fail closed.
 */
export async function isOwnerKey(
  rpc: NearRpc,
  accountId: string,
  publicKey: string,
): Promise<boolean> {
  const key = parseEd25519PublicKey(publicKey);
  if (!key) return false;
  if (IMPLICIT_ACCOUNT.test(accountId) && !(await rpc.viewAccount(accountId))) {
    return Buffer.from(key).toString("hex") === accountId;
  }
  return (await rpc.viewAccessKey(accountId, publicKey)) === "full_access";
}
