import { readFileSync } from "node:fs";
import { base58, base64 } from "@scure/base";
import { TREASURY_ASSET_ID } from "@veylo/core";
import { describe, expect, it, vi } from "vitest";
import {
  createOneClickTreasuryClient,
  encodeVersionedNonce,
  nonceSaltHex,
  OneClickError,
  QuoteGuardError,
  sessionMessage,
  shieldPayloadProblem,
  toSignedData,
  verifyNep413,
} from "./index.js";

const fx = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/treasury-${name}.json`, import.meta.url), "utf8"),
  ) as { status: number; body: any; request?: any };

const TREASURY = "a87a0e4f93085edbe787aa4530021045f426c8fbc500a7c1dbd729dc4f8151ce";
const REFUND = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
const DEADLINE = new Date("2026-11-05T15:41:27.252Z");
const BSC_USDT = "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g";

/** Answers each request in turn. */
function queue(...replies: { status: number; body: unknown }[]) {
  const sent: { url: string; init: RequestInit; body: any }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: init.body ? JSON.parse(init.body as string) : undefined });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  const client = createOneClickTreasuryClient({
    apiKey: "partner-key-sentinel",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { client, sent, fetch };
}

const funding = (recipient = TREASURY) => ({
  treasuryAccountId: TREASURY,
  recipient,
  originAsset: BSC_USDT,
  amount: "2000000000000000000",
  refundAddress: REFUND,
  deadline: DEADLINE,
});
const shield = (over: object = {}) => ({
  treasuryAccountId: TREASURY,
  recipient: TREASURY,
  refundTo: TREASURY,
  amount: "300000",
  deadline: DEADLINE,
  ...over,
});

describe("the live-quote guard (L30)", () => {
  it("exposes no generic quote method", () => {
    const { client } = queue();
    const names = Object.keys(client);
    expect(names.filter((n) => /quote/i.test(n)).sort()).toEqual([
      "createFundingQuote",
      "createPayoutQuote",
      "createShieldQuote",
    ]);
    expect(names.filter((n) => /^(call|post|send|request|fetch|quote|raw)$/i.test(n))).toEqual([]);
  });

  it("the only payout quote is the guarded createPayoutQuote (L34)", () => {
    const { client } = queue();
    expect(Object.keys(client).filter((n) => /payout|transfer.*quote/i.test(n))).toEqual([
      "createPayoutQuote",
    ]);
  });

  describe("funding", () => {
    it("throws, before any network call, if the recipient isn't the treasury", () => {
      const { client, fetch } = queue();
      expect(() => client.createFundingQuote(funding("attacker.near"))).toThrow(QuoteGuardError);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("throws with no refund address", () => {
      const { client } = queue();
      expect(() => client.createFundingQuote({ ...funding(), refundAddress: "" })).toThrow(
        QuoteGuardError,
      );
    });

    it("sends dry, then live, to the treasury with recipientType INTENTS", async () => {
      const { client, sent } = queue(fx("funding-dry"), fx("funding-live"));
      const live = await client.createFundingQuote(funding());
      expect(sent.map((s) => s.body.dry)).toEqual([true, false]);
      for (const s of sent) {
        expect(s.body).toMatchObject({
          recipient: TREASURY,
          recipientType: "INTENTS",
          depositType: "ORIGIN_CHAIN",
          refundTo: REFUND,
          refundType: "ORIGIN_CHAIN",
          destinationAsset: TREASURY_ASSET_ID,
        });
      }
      expect(live).toMatchObject({
        depositAddress: "0x11d0411de9b6c725D94aF2d24fC6A6cF4F11bE84",
        amountIn: "2000000000000000000",
        deadline: "2026-11-08T15:41:27.252Z",
      });
    });

    it("a refused dry quote never reaches live", async () => {
      const refused = { status: 400, body: { message: "recipient is not valid" } };
      const { client, sent } = queue(refused);
      await expect(client.createFundingQuote(funding())).rejects.toMatchObject({
        kind: "rejected",
        detail: "recipient is not valid",
      });
      expect(sent).toHaveLength(1);
    });

    it("refuses a response echoing a different recipient", async () => {
      const dry = fx("funding-dry");
      const evil = {
        status: 201,
        body: { ...dry.body, quoteRequest: { ...dry.body.quoteRequest, recipient: "evil.near" } },
      };
      const { client, sent } = queue(evil);
      await expect(client.createFundingQuote(funding())).rejects.toBeInstanceOf(QuoteGuardError);
      expect(sent).toHaveLength(1);
    });

    it("refuses a live response echoing a different refund", async () => {
      const live = fx("funding-live");
      const evil = {
        status: 201,
        body: { ...live.body, quoteRequest: { ...live.body.quoteRequest, refundTo: "0xevil" } },
      };
      const { client } = queue(fx("funding-dry"), evil);
      await expect(client.createFundingQuote(funding())).rejects.toBeInstanceOf(QuoteGuardError);
    });

    it("refuses a live response with no deposit address", async () => {
      const { client } = queue(fx("funding-dry"), fx("funding-dry"));
      await expect(client.createFundingQuote(funding())).rejects.toBeInstanceOf(OneClickError);
    });
  });

  describe("shield", () => {
    it.each([
      ["recipient", { recipient: "attacker.near" }],
      ["refund", { refundTo: "attacker.near" }],
    ])("throws, before any network call, if the %s isn't the treasury", (_n, change) => {
      const { client, fetch } = queue();
      expect(() => client.createShieldQuote(shield(change))).toThrow(QuoteGuardError);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("sends dry, then live: INTENTS to CONFIDENTIAL_INTENTS, all on the treasury", async () => {
      const { client, sent } = queue(fx("shield-dry"), fx("shield-live"));
      const live = await client.createShieldQuote(shield());
      expect(sent.map((s) => s.body.dry)).toEqual([true, false]);
      for (const s of sent) {
        expect(s.body).toMatchObject({
          depositType: "INTENTS",
          recipient: TREASURY,
          recipientType: "CONFIDENTIAL_INTENTS",
          refundTo: TREASURY,
          refundType: "INTENTS",
        });
      }
      expect(live.depositAddress).toBe(
        "f888b932a1d6f40914a84d2df193907714943d2bd926a8a1c1404e05f36d9153",
      );
    });

    it("refuses a response echoing a non-confidential recipient type", async () => {
      const dry = fx("shield-dry");
      const evil = {
        status: 201,
        body: { ...dry.body, quoteRequest: { ...dry.body.quoteRequest, recipientType: "INTENTS" } },
      };
      const { client } = queue(evil);
      await expect(client.createShieldQuote(shield())).rejects.toBeInstanceOf(QuoteGuardError);
    });
  });
});

describe("the recorded shield payload", () => {
  const payload = fx("shield-generate").body.intent.payload;
  const expected = {
    signerId: TREASURY,
    depositAddress: "f888b932a1d6f40914a84d2df193907714943d2bd926a8a1c1404e05f36d9153",
    tokenId: TREASURY_ASSET_ID,
    amount: "300000",
    verifier: "intents.near",
    saltHex: "252812b3",
  };

  it("passes every check", () => {
    expect(shieldPayloadProblem(payload, expected)).toBeUndefined();
  });

  it("the recorded signature verifies once mapped to wallet form, and maps back exactly", () => {
    const signed = fx("shield-submit").request.signedData;
    const walletSignature = base64.encode(base58.decode(signed.signature.slice(8)));
    expect(
      verifyNep413({
        message: payload.message,
        nonce: base64.decode(payload.nonce),
        recipient: payload.recipient,
        publicKey: signed.public_key,
        signature: walletSignature,
      }),
    ).toBe(true);
    expect(
      toSignedData(payload, { publicKey: signed.public_key, signature: walletSignature }),
    ).toEqual(signed);
  });

  const message = (change: (m: any) => void) => {
    const m = JSON.parse(payload.message);
    change(m);
    return { ...payload, message: JSON.stringify(m) };
  };
  it.each<[string, any]>([
    ["wrong verifier", { ...payload, recipient: "intents.far" }],
    ["wrong nonce or salt", { ...payload, nonce: base64.encode(new Uint8Array(32)) }],
    ["message is not JSON", { ...payload, message: "x" }],
    ["wrong signer", message((m) => (m.signer_id = "evil.near"))],
    ["wrong receiver", message((m) => (m.intents[0].receiver_id = "evil.near"))],
    ["wrong amount", message((m) => (m.intents[0].tokens[TREASURY_ASSET_ID] = "300001"))],
    ["wrong token", message((m) => (m.intents[0].tokens = { "nep141:other": "300000" }))],
    [
      "wrong token",
      message((m) => (m.intents[0].tokens = { [TREASURY_ASSET_ID]: "300000", other: "1" })),
    ],
    ["not a single transfer", message((m) => m.intents.push(m.intents[0]))],
    ["not a single transfer", message((m) => (m.intents = []))],
    ["not a single transfer", message((m) => (m.extra = 1))],
    ["not a single transfer", message((m) => (m.intents[0].intent = "ft_withdraw"))],
  ])("rejects: %s", (problem, tampered) => {
    expect(shieldPayloadProblem(tampered, expected)).toBe(problem);
  });

  it("rejects another chain's salt, read at runtime", () => {
    expect(shieldPayloadProblem(payload, { ...expected, saltHex: "e110f317" })).toBe(
      "wrong nonce or salt",
    );
  });
});

describe("versioned nonce", () => {
  it("reproduces the recorded T5c nonce byte for byte", () => {
    const recorded = "Vij2xgAlKBKzAIPkVkg35RgAy399AjflGHlSp32vpiU=";
    const bytes = base64.decode(recorded);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const startMs = view.getBigUint64(17, true) / 1_000_000n;
    expect(
      encodeVersionedNonce({
        saltHex: "252812b3",
        deadline: new Date("2026-11-05T17:46:50.412Z"),
        start: new Date(Number(startMs)),
        random: bytes.slice(25),
      }),
    ).toBe(recorded);
    expect(nonceSaltHex(recorded)).toBe("252812b3");
  });

  it("uses whatever salt it's given", () => {
    const nonce = encodeVersionedNonce({
      saltHex: "e110f317",
      deadline: new Date(0),
      start: new Date(0),
      random: new Uint8Array(7),
    });
    expect(nonceSaltHex(nonce)).toBe("e110f317");
  });

  it("a random 32 bytes isn't a versioned nonce", () => {
    expect(nonceSaltHex(base64.encode(new Uint8Array(32).fill(9)))).toBeUndefined();
  });

  it.each([
    ["aabb", 7],
    ["252812b3", 6],
  ])("refuses salt %s with %i random bytes", (saltHex, n) => {
    expect(() =>
      encodeVersionedNonce({
        saltHex,
        deadline: new Date(0),
        start: new Date(0),
        random: new Uint8Array(n),
      }),
    ).toThrow(RangeError);
  });
});

describe("session calls", () => {
  it("the session message is the recorded empty intent", () => {
    expect(sessionMessage(TREASURY, new Date("2026-11-05T17:46:50.412Z"))).toBe(
      `{"deadline":"2026-11-05T17:46:50.412Z","intents":[],"signer_id":"${TREASURY}"}`,
    );
  });

  it("authenticate parses the recorded shape", async () => {
    const { client, sent } = queue(fx("authenticate"));
    const tokens = await client.authenticate({} as never);
    expect(tokens.expiresIn).toBe(900);
    expect(tokens.refreshExpiresIn).toBe(604800);
    expect(sent[0]?.url).toContain("/v0/auth/authenticate");
    expect(sent[0]?.body).toEqual({ signedData: {} });
  });

  it("refresh parses the recorded shape: no new refresh token", async () => {
    const { client } = queue(fx("refresh"));
    expect(await client.refresh("r")).toEqual({
      accessToken: expect.any(String),
      expiresIn: 900,
    });
  });

  it("balances sends the session as a bearer token", async () => {
    const { client, sent } = queue(fx("balances"));
    const res = await client.balances("access");
    expect(res.balances[0]).toMatchObject({ tokenId: TREASURY_ASSET_ID, source: "private" });
    expect((sent[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer access");
  });

  it("a 401 reads as unauthorized, and errors hold no secret", async () => {
    const { client } = queue({ status: 401, body: { message: "token-sentinel expired" } });
    const err = await client.balances("token-sentinel").catch((e) => e);
    expect(err).toBeInstanceOf(OneClickError);
    expect(err.kind).toBe("unauthorized");
    expect(JSON.stringify({ m: err.message, d: err.detail })).not.toContain("token-sentinel");
  });

  it("status passes the partner key and encodes the address", async () => {
    const { client, sent } = queue({ status: 200, body: { status: "PENDING_DEPOSIT" } });
    await client.status("0xabc&x=1");
    expect(sent[0]?.url).toContain("depositAddress=0xabc%26x%3D1");
    expect((sent[0]?.init.headers as Record<string, string>)["x-api-key"]).toBe(
      "partner-key-sentinel",
    );
  });

  it("no treasury fixture holds a token", () => {
    for (const name of ["authenticate", "refresh"]) {
      expect(JSON.stringify(fx(name))).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    }
  });
});
