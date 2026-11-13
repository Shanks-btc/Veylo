// The session gate: a wallet is only ever asked to sign an empty intent for its own account.
import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { checkSessionRequest } from "./session";

const NOW = new Date("2026-11-12T10:00:00.000Z");
const ACCOUNT = "ada.near";
const nonce = base64.encode(new Uint8Array(32).fill(7));
const deadline = new Date(NOW.getTime() + 5 * 60_000).toISOString();
const message = (over: object = {}) =>
  JSON.stringify({ deadline, intents: [], signer_id: ACCOUNT, ...over });
const good = { message: message(), nonce, recipient: "intents.near" };
const check = (over: Partial<typeof good> = {}, accountId = ACCOUNT, now = NOW) =>
  checkSessionRequest({ ...good, ...over }, { accountId, now });

describe("checkSessionRequest", () => {
  it("accepts an empty intent for the wallet's own account", () => {
    const r = check();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nonce).toHaveLength(32);
  });

  it("refuses an intent that does anything: a transfer is not a session", () => {
    const transfer = message({
      intents: [{ intent: "transfer", receiver_id: "thief.near", tokens: { "nep141:usdc": "1" } }],
    });
    expect(check({ message: transfer })).toMatchObject({ ok: false });
  });

  it("refuses another account, another verifier, and extra fields", () => {
    expect(check({}, "someone-else.near")).toMatchObject({ ok: false });
    expect(check({ recipient: "evil.near" })).toMatchObject({ ok: false });
    expect(check({ message: message({ memo: "hi" }) })).toMatchObject({ ok: false });
  });

  it("refuses bytes that mean the same but are not the exact form", () => {
    const spaced = `{ "deadline": "${deadline}", "intents": [], "signer_id": "${ACCOUNT}" }`;
    expect(check({ message: spaced })).toMatchObject({ ok: false });
    const reordered = `{"signer_id":"${ACCOUNT}","intents":[],"deadline":"${deadline}"}`;
    expect(check({ message: reordered })).toMatchObject({ ok: false });
  });

  it("refuses a request that has expired or stays open too long", () => {
    expect(check({}, ACCOUNT, new Date(NOW.getTime() + 6 * 60_000))).toMatchObject({ ok: false });
    const long = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    expect(check({ message: message({ deadline: long }) })).toMatchObject({ ok: false });
  });

  it("refuses a nonce that is not 32 bytes, and text that is not JSON", () => {
    expect(check({ nonce: base64.encode(new Uint8Array(8)) })).toMatchObject({ ok: false });
    expect(check({ nonce: "!!!" })).toMatchObject({ ok: false });
    expect(check({ message: "not json" })).toMatchObject({ ok: false });
  });
});
