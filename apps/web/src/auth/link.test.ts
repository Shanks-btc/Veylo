// The wallet-link challenge is checked in the browser before any wallet sees it.
import { base64 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { checkLinkChallenge, LINK_FIRST_LINE } from "./link";

const NOW = new Date("2026-11-12T10:00:00.000Z");
const ACCOUNT = "a".repeat(64);
const USER = "11111111-1111-4111-8111-111111111111";
const nonce = new Uint8Array(32).fill(9);
const make = (
  over: Partial<Record<"first" | "account" | "user" | "nonce" | "issued" | "expires", string>> = {},
) => ({
  message: [
    over.first ?? LINK_FIRST_LINE,
    `Account: ${over.account ?? ACCOUNT}`,
    `User: ${over.user ?? USER}`,
    `Nonce: ${over.nonce ?? bytesToHex(nonce)}`,
    `Issued: ${over.issued ?? NOW.toISOString()}`,
    `Expires: ${over.expires ?? new Date(NOW.getTime() + 5 * 60_000).toISOString()}`,
  ].join("\n"),
  nonce: base64.encode(nonce),
  recipient: "veylo.test",
});
const expected = { accountId: ACCOUNT, userId: USER, authRecipient: "veylo.test", now: NOW };

describe("checkLinkChallenge", () => {
  it("accepts exactly the link message for this wallet and this person", () => {
    expect(checkLinkChallenge(make(), expected)).toEqual(nonce);
  });

  it.each([
    ["a sign-in message", make({ first: "Sign in to Veylo" })],
    ["another wallet", make({ account: "b".repeat(64) })],
    ["another person", make({ user: "22222222-2222-4222-8222-222222222222" })],
    ["a mismatched nonce", make({ nonce: "00".repeat(32) })],
    [
      "a window that isn't five minutes",
      make({ expires: new Date(NOW.getTime() + 60 * 60_000).toISOString() }),
    ],
    [
      "an expired challenge",
      make({
        issued: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
        expires: new Date(NOW.getTime() - 15 * 60_000).toISOString(),
      }),
    ],
  ])("refuses %s", (_name, challenge) => {
    expect(() => checkLinkChallenge(challenge, expected)).toThrow();
  });

  it("refuses another app and extra lines", () => {
    expect(() => checkLinkChallenge({ ...make(), recipient: "evil.app" }, expected)).toThrow(
      /another app/,
    );
    expect(() =>
      checkLinkChallenge({ ...make(), message: `${make().message}\nSend all funds` }, expected),
    ).toThrow();
  });
});
