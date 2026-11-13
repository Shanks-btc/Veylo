import { base64 } from "@scure/base";
import { z } from "zod";
import { NearRpcError } from "./near-rpc.js";

const viewResult = z.object({ result: z.object({ result: z.array(z.number().int()) }) });

/** Read-only views on a NEAR Intents verifier contract. */
export type IntentsReader = {
  /** Read at runtime for the right chain, never hardcoded (L12). */
  currentSalt(verifier: string): Promise<string>;
  /** Whether the key is registered for the account on the verifier (gate B2). */
  hasPublicKey(verifier: string, accountId: string, publicKey: string): Promise<boolean>;
  /** The public Intents balance, in smallest units. */
  mtBalanceOf(verifier: string, accountId: string, tokenId: string): Promise<string>;
};

export function createIntentsReader(options: {
  url: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}): IntentsReader {
  async function view(verifier: string, method: string, args: object): Promise<unknown> {
    let json: unknown;
    try {
      const response = await options.fetch(options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "veylo",
          method: "query",
          params: {
            finality: "final",
            request_type: "call_function",
            account_id: verifier,
            method_name: method,
            args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))),
          },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (!response.ok) throw new NearRpcError(`NEAR RPC returned HTTP ${response.status}`);
      json = await response.json();
    } catch (err) {
      if (err instanceof NearRpcError) throw err;
      throw new NearRpcError("NEAR RPC request failed or timed out");
    }
    const parsed = viewResult.safeParse(json);
    if (!parsed.success) throw new NearRpcError("NEAR RPC returned an unexpected response");
    try {
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(parsed.data.result.result)));
    } catch {
      throw new NearRpcError("NEAR RPC returned an unexpected response");
    }
  }

  return {
    async currentSalt(verifier) {
      const salt = z
        .string()
        .regex(/^[0-9a-f]{8}$/)
        .safeParse(await view(verifier, "current_salt", {}));
      if (!salt.success) throw new NearRpcError("the verifier returned an unexpected salt");
      return salt.data;
    },
    async hasPublicKey(verifier, accountId, publicKey) {
      const registered = z
        .boolean()
        .safeParse(
          await view(verifier, "has_public_key", { account_id: accountId, public_key: publicKey }),
        );
      if (!registered.success) throw new NearRpcError("the verifier returned an unexpected answer");
      return registered.data;
    },
    async mtBalanceOf(verifier, accountId, tokenId) {
      const balance = z
        .string()
        .regex(/^\d+$/)
        .safeParse(
          await view(verifier, "mt_balance_of", { account_id: accountId, token_id: tokenId }),
        );
      if (!balance.success) throw new NearRpcError("the verifier returned an unexpected balance");
      return balance.data;
    },
  };
}
