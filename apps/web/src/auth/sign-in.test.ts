import { bytesToHex } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import type { WalletSigner } from "../wallet/types.js";
import { checkChallenge, SignInError, signIn, signOut } from "./sign-in.js";

const AUTH = "veylo.app";
const ACCOUNT = "ada.near";
const NOW = new Date("2026-11-10T10:00:30.000Z");
const NONCE = new Uint8Array(32).fill(5);

/** Exactly what the API's /auth/challenge produces (auth-routes.ts). */
function challenge(
  over: Partial<{
    account: string;
    nonceHex: string;
    issued: string;
    expires: string;
    recipient: string;
    first: string;
  }> = {},
) {
  const lines = [
    over.first ?? "Sign in to Veylo",
    `Account: ${over.account ?? ACCOUNT}`,
    `Nonce: ${over.nonceHex ?? bytesToHex(NONCE)}`,
    `Issued: ${over.issued ?? "2026-11-10T10:00:00.000Z"}`,
    `Expires: ${over.expires ?? "2026-11-10T10:05:00.000Z"}`,
  ];
  return {
    message: lines.join("\n"),
    nonce: base64.encode(NONCE),
    recipient: over.recipient ?? AUTH,
  };
}

describe("challenge check: the wallet only ever sees a real sign-in challenge", () => {
  it("accepts the API's exact format", () => {
    expect(
      checkChallenge(challenge(), { accountId: ACCOUNT, authRecipient: AUTH, now: NOW }),
    ).toEqual(NONCE);
  });

  it.each([
    ["another app", challenge({ recipient: "evil.app" })],
    ["another account", challenge({ account: "mallory.near" })],
    ["a nonce mismatch", challenge({ nonceHex: "00".repeat(32) })],
    [
      "an expired window",
      challenge({ issued: "2026-11-10T09:50:00.000Z", expires: "2026-11-10T09:55:00.000Z" }),
    ],
    ["a long window", challenge({ expires: "2026-11-10T11:00:00.000Z" })],
    [
      "a payee approval in disguise",
      { ...challenge(), message: "Veylo payee approval v1\nOrg: x" },
    ],
    ["an extra line", { ...challenge(), message: `${challenge().message}\nPay to: attacker` }],
  ])("refuses %s", (_name, c) => {
    expect(() => checkChallenge(c, { accountId: ACCOUNT, authRecipient: AUTH, now: NOW })).toThrow(
      SignInError,
    );
  });
});

describe("sign-in flow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("challenge → NEP-413 sign → verify, with no token in localStorage", async () => {
    const storage = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    const calls: { url: string; body: unknown }[] = [];
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: url.pathname, body });
      const json =
        url.pathname === "/auth/challenge"
          ? challenge()
          : url.pathname === "/auth/verify"
            ? { accountId: ACCOUNT }
            : { ok: true };
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "set-cookie": "veylo_session=x; HttpOnly" },
      });
    });
    const signed: unknown[] = [];
    const wallet: WalletSigner = {
      connect: async () => ({ accountId: ACCOUNT }),
      signMessage: async (input) => {
        signed.push(input);
        return { accountId: ACCOUNT, publicKey: "ed25519:key", signature: "c2ln" };
      },
      disconnect: vi.fn(async () => {}),
    };
    const api = createApiClient({ origin: "https://api.veylo.test", fetch: fetch as never });
    await expect(signIn({ api, wallet, authRecipient: AUTH, now: () => NOW })).resolves.toEqual({
      accountId: ACCOUNT,
    });
    expect(signed).toEqual([{ message: challenge().message, recipient: AUTH, nonce: NONCE }]);
    expect(calls[1]).toEqual({
      url: "/auth/verify",
      body: {
        accountId: ACCOUNT,
        publicKey: "ed25519:key",
        signature: "c2ln",
        nonce: base64.encode(NONCE),
      },
    });
    await signOut({ api, wallet });
    expect(calls.at(-1)?.url).toBe("/auth/logout");
    expect(wallet.disconnect).toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("never asks the wallet to sign a challenge that fails the check", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(challenge({ account: "mallory.near" }))),
    );
    const wallet: WalletSigner = {
      connect: async () => ({ accountId: ACCOUNT }),
      signMessage: vi.fn(),
      disconnect: async () => {},
    };
    const api = createApiClient({ origin: "https://api.veylo.test", fetch: fetch as never });
    await expect(
      signIn({ api, wallet, authRecipient: AUTH, now: () => NOW }),
    ).rejects.toBeInstanceOf(SignInError);
    expect(wallet.signMessage).not.toHaveBeenCalled();
  });

  it("refuses a wallet that signs as another account", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(challenge())));
    const wallet: WalletSigner = {
      connect: async () => ({ accountId: ACCOUNT }),
      signMessage: async () => ({
        accountId: "mallory.near",
        publicKey: "ed25519:k",
        signature: "s",
      }),
      disconnect: async () => {},
    };
    const api = createApiClient({ origin: "https://api.veylo.test", fetch: fetch as never });
    await expect(signIn({ api, wallet, authRecipient: AUTH, now: () => NOW })).rejects.toThrow(
      /another account/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
