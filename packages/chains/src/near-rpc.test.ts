import { base58 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { createNearRpc, isOwnerKey, NearRpcError, type NearRpc } from "./index.js";

const KEY_BYTES = new Uint8Array(32).fill(9);
const KEY = `ed25519:${base58.encode(KEY_BYTES)}`;
const IMPLICIT = Buffer.from(KEY_BYTES).toString("hex");

const respond = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));
const rpcWith = (fetch: unknown, timeoutMs?: number) =>
  createNearRpc({ url: "https://rpc.test", fetch: fetch as typeof globalThis.fetch, timeoutMs });

const FUNCTION_CALL = {
  FunctionCall: { allowance: null, method_names: [], receiver_id: "x.near" },
};
const META = { block_hash: "h", block_height: 1, nonce: 1 };

describe("viewAccessKey", () => {
  it("sends a final-finality query", async () => {
    const fetch = respond({ result: { ...META, permission: "FullAccess" } });
    await rpcWith(fetch).viewAccessKey("a.near", KEY);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rpc.test");
    expect(JSON.parse(init.body as string).params).toEqual({
      finality: "final",
      request_type: "view_access_key",
      account_id: "a.near",
      public_key: KEY,
    });
  });

  it("reads FullAccess and FunctionCall", async () => {
    await expect(
      rpcWith(respond({ result: { ...META, permission: "FullAccess" } })).viewAccessKey("a", KEY),
    ).resolves.toBe("full_access");
    await expect(
      rpcWith(respond({ result: { ...META, permission: FUNCTION_CALL } })).viewAccessKey("a", KEY),
    ).resolves.toBe("function_call");
  });

  it("treats the live 'does not exist' result as no key", async () => {
    const body = {
      result: {
        block_hash: "h",
        block_height: 1,
        error: `access key ${KEY} does not exist while viewing`,
        logs: [],
      },
    };
    await expect(rpcWith(respond(body)).viewAccessKey("a", KEY)).resolves.toBeUndefined();
  });

  it.each(["UNKNOWN_ACCESS_KEY", "UNKNOWN_ACCOUNT"])(
    "treats error cause %s as no key",
    async (n) => {
      const body = { error: { name: "HANDLER_ERROR", cause: { name: n } } };
      await expect(rpcWith(respond(body)).viewAccessKey("a", KEY)).resolves.toBeUndefined();
    },
  );

  it.each([
    ["another RPC error", respond({ error: { cause: { name: "INTERNAL_ERROR" } } })],
    ["another result error", respond({ result: { error: "something else" } })],
    ["HTTP 500", respond({}, 500)],
    ["no result", respond({})],
    ["an unknown permission", respond({ result: { permission: "Everything" } })],
    [
      "a network failure",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    ],
  ])("throws on %s", async (_name, fetch) => {
    await expect(rpcWith(fetch).viewAccessKey("a", KEY)).rejects.toBeInstanceOf(NearRpcError);
  });

  it("times out", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(rpcWith(hang, 10).viewAccessKey("a", KEY)).rejects.toBeInstanceOf(NearRpcError);
  });
});

describe("viewAccessKeyList", () => {
  it("maps keys", async () => {
    const fetch = respond({
      result: {
        block_hash: "h",
        block_height: 1,
        keys: [
          { public_key: KEY, access_key: { nonce: 1, permission: "FullAccess" } },
          { public_key: "ed25519:o", access_key: { nonce: 1, permission: FUNCTION_CALL } },
        ],
      },
    });
    await expect(rpcWith(fetch).viewAccessKeyList("a.near")).resolves.toEqual([
      { publicKey: KEY, permission: "full_access" },
      { publicKey: "ed25519:o", permission: "function_call" },
    ]);
  });
});

describe("viewAccount", () => {
  it("is true for an account the node returns", async () => {
    const body = { result: { amount: "1", block_hash: "h", block_height: 1, locked: "0" } };
    await expect(rpcWith(respond(body)).viewAccount("a.near")).resolves.toBe(true);
  });

  it("is false for the live UNKNOWN_ACCOUNT error", async () => {
    const body = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } };
    await expect(rpcWith(respond(body)).viewAccount("a.near")).resolves.toBe(false);
  });

  it("throws on anything it can't read", async () => {
    await expect(rpcWith(respond({}, 500)).viewAccount("a")).rejects.toBeInstanceOf(NearRpcError);
    await expect(rpcWith(respond({ result: {} })).viewAccount("a")).rejects.toBeInstanceOf(
      NearRpcError,
    );
  });
});

describe("isOwnerKey", () => {
  const rpc = (answer: "full_access" | "function_call" | undefined, exists = true): NearRpc => ({
    viewAccount: vi.fn(async () => exists),
    viewAccessKey: vi.fn(async () => answer),
    viewAccessKeyList: vi.fn(async () => []),
  });
  const OTHER = `ed25519:${base58.encode(new Uint8Array(32).fill(1))}`;

  describe("implicit account", () => {
    it("never funded: the deriving key is accepted", async () => {
      const r = rpc(undefined, false);
      await expect(isOwnerKey(r, IMPLICIT, KEY)).resolves.toBe(true);
      expect(r.viewAccessKey).not.toHaveBeenCalled();
    });

    it("never funded: any other key is rejected", async () => {
      await expect(isOwnerKey(rpc("full_access", false), IMPLICIT, OTHER)).resolves.toBe(false);
    });

    it("exists: the deriving key is accepted if it's still FullAccess", async () => {
      await expect(isOwnerKey(rpc("full_access"), IMPLICIT, KEY)).resolves.toBe(true);
    });

    it("exists: a rotated-out deriving key is rejected", async () => {
      await expect(isOwnerKey(rpc(undefined), IMPLICIT, KEY)).resolves.toBe(false);
    });

    it("exists: a deriving key reduced to function-call is rejected", async () => {
      await expect(isOwnerKey(rpc("function_call"), IMPLICIT, KEY)).resolves.toBe(false);
    });

    it("exists: another FullAccess key is accepted", async () => {
      await expect(isOwnerKey(rpc("full_access"), IMPLICIT, OTHER)).resolves.toBe(true);
    });
  });

  it("named: accepts only FullAccess, and doesn't need the account lookup", async () => {
    const r = rpc("full_access", false);
    await expect(isOwnerKey(r, "a.near", KEY)).resolves.toBe(true);
    expect(r.viewAccount).not.toHaveBeenCalled();
    await expect(isOwnerKey(rpc("function_call"), "a.near", KEY)).resolves.toBe(false);
    await expect(isOwnerKey(rpc(undefined), "a.near", KEY)).resolves.toBe(false);
  });

  it("rejects a malformed key", async () => {
    await expect(isOwnerKey(rpc("full_access"), "a.near", "nonsense")).resolves.toBe(false);
  });

  it.each([
    ["named", "a.near"],
    ["implicit", IMPLICIT],
  ])("lets RPC failures propagate for a %s account, so callers fail closed", async (_n, id) => {
    const down = async () => {
      throw new NearRpcError("down");
    };
    const broken: NearRpc = {
      viewAccount: down,
      viewAccessKey: down,
      viewAccessKeyList: async () => [],
    };
    await expect(isOwnerKey(broken, id, KEY)).rejects.toBeInstanceOf(NearRpcError);
  });
});
