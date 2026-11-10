import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPayoutRoute, PAYOUT_ROUTE_IDS, TREASURY_ASSET_ID } from "@veylo/core";
import { describe, expect, it, vi } from "vitest";
import {
  acceptanceQuote,
  assertDry,
  createOneClickDryClient,
  type DryQuoteInput,
  type OneClickLogEvent,
} from "./index.js";

const fixtureDir = new URL("./fixtures/", import.meta.url);
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`oneclick-${name}.json`, fixtureDir), "utf8")) as {
    status: number;
    body: { quoteRequest?: Record<string, unknown>; quote?: Record<string, unknown> };
  };

const KEY = "partner-key-sentinel";
const INPUT = acceptanceQuote({
  route: getPayoutRoute("usdc-base"),
  recipient: "0xAf780910c0E7D41430D4615A437676a87a332C8C",
  treasuryAccountId: "treasury.near",
  deadline: new Date("2026-11-06T10:10:00.000Z"),
});

const respondWith = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));
const client = (fetch: unknown, log?: (e: OneClickLogEvent) => void, timeoutMs?: number) =>
  createOneClickDryClient({
    apiKey: KEY,
    fetch: fetch as typeof globalThis.fetch,
    ...(log ? { log } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
const sent = (fetch: ReturnType<typeof respondWith>) => {
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string),
  };
};
const accepted = () => {
  const f = fixture("accepted");
  return respondWith(f.status, f.body);
};

describe("the live-quote guard", () => {
  it("always sends dry: true", async () => {
    const fetch = accepted();
    await client(fetch).dryQuote(INPUT);
    expect(sent(fetch).body.dry).toBe(true);
  });

  it.each([[false], [true], ["false"], [undefined]])(
    "refuses a caller passing dry: %j, before any network call",
    async (dry) => {
      const fetch = accepted();
      await expect(
        client(fetch).dryQuote({ ...INPUT, dry } as unknown as DryQuoteInput),
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("assertDry refuses anything but true", () => {
    expect(() => assertDry({ dry: true })).not.toThrow();
    for (const dry of [false, undefined, "true", 1]) {
      expect(() => assertDry({ dry })).toThrow("only sends dry quotes");
    }
  });

  it("treats a response carrying a deposit address as a failed check, never accepted", async () => {
    const { body, status } = fixture("accepted");
    const live = { ...body, quote: { ...body.quote, depositAddress: "abc" } };
    const result = await client(respondWith(status, live)).dryQuote(INPUT);
    expect(result.outcome).toBe("check_failed");
  });

  it("treats a response that says it wasn't dry as a failed check", async () => {
    const { body, status } = fixture("accepted");
    const live = { ...body, quoteRequest: { ...body.quoteRequest, dry: false } };
    const result = await client(respondWith(status, live)).dryQuote(INPUT);
    expect(result.outcome).toBe("check_failed");
  });

  it("the package exposes no other way to quote", async () => {
    const api = await import("./index.js");
    expect(
      Object.keys(api)
        .filter((k) => /quote/i.test(k))
        .sort(),
    ).toEqual([
      "ONECLICK_QUOTE_KEY",
      "QuoteGuardError",
      "acceptanceQuote",
      "oneClickQuoteHash",
      "verifyQuoteSignature",
    ]);
  });
});

describe("request", () => {
  it("posts to /v0/quote with the X-API-Key header", async () => {
    const fetch = accepted();
    await client(fetch).dryQuote(INPUT);
    const { url, headers } = sent(fetch);
    expect(url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(headers["x-api-key"]).toBe(KEY);
  });

  it("Direct: confidential deposit to the destination chain, EXACT_OUTPUT 1 USDC", () => {
    expect(INPUT).toEqual({
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: TREASURY_ASSET_ID,
      depositType: "CONFIDENTIAL_INTENTS",
      destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      amount: "1000000",
      recipient: "0xAf780910c0E7D41430D4615A437676a87a332C8C",
      recipientType: "DESTINATION_CHAIN",
      refundTo: "treasury.near",
      refundType: "CONFIDENTIAL_INTENTS",
      deadline: "2026-11-06T10:10:00.000Z",
    });
  });

  it("Private: recipient type is CONFIDENTIAL_INTENTS", () => {
    const quote = acceptanceQuote({
      route: getPayoutRoute("usdc-near-confidential"),
      recipient: "bob.near",
      treasuryAccountId: "treasury.near",
      deadline: new Date("2026-11-06T10:10:00.000Z"),
    });
    expect(quote).toMatchObject({
      recipient: "bob.near",
      recipientType: "CONFIDENTIAL_INTENTS",
      destinationAsset: TREASURY_ASSET_ID,
    });
  });

  it.each(PAYOUT_ROUTE_IDS)("the client accepts the quote built for %s", async (id) => {
    const fetch = accepted();
    const quote = acceptanceQuote({
      route: getPayoutRoute(id),
      recipient: "r",
      treasuryAccountId: "t",
      deadline: new Date(0),
    });
    await expect(client(fetch).dryQuote(quote)).resolves.toMatchObject({ outcome: "accepted" });
  });
});

describe("recorded Phase 2 responses", () => {
  it("accepted: returns the amounts", async () => {
    await expect(client(accepted()).dryQuote(INPUT)).resolves.toEqual({
      outcome: "accepted",
      amountIn: "105882",
      minAmountIn: "104823",
      amountOut: "100000",
      withdrawFee: "4800",
    });
  });

  it("recipient rejected: keeps 1Click's reason", async () => {
    const f = fixture("recipient-rejected");
    await expect(client(respondWith(f.status, f.body)).dryQuote(INPUT)).resolves.toEqual({
      outcome: "rejected",
      reason: "recipient is not valid",
    });
  });

  it("pair unavailable: route_unavailable, not a rejection of the address", async () => {
    const f = fixture("pair-unavailable");
    await expect(client(respondWith(f.status, f.body)).dryQuote(INPUT)).resolves.toEqual({
      outcome: "route_unavailable",
      reason: "Quoting for this pair is not available",
    });
  });
});

describe("failures are retryable, and never read as a rejection", () => {
  it.each([401, 403, 408, 429, 500, 503])("HTTP %i", async (status) => {
    const result = await client(respondWith(status, { message: "x" })).dryQuote(INPUT);
    expect(result).toEqual({ outcome: "check_failed", reason: `1Click returned HTTP ${status}` });
  });

  it.each([
    ["a network failure", vi.fn(async () => Promise.reject(new Error("boom")))],
    ["a body that isn't JSON", vi.fn(async () => new Response("<html>", { status: 200 }))],
    ["a 400 with no message", respondWith(400, {})],
    ["a 201 with the wrong shape", respondWith(201, { quote: {} })],
    ["a float amount", respondWith(201, { quote: { amountIn: 1.5 }, quoteRequest: { dry: true } })],
  ])("%s", async (_name, fetch) => {
    const result = await client(fetch).dryQuote(INPUT);
    expect(result.outcome).toBe("check_failed");
  });

  it("a timeout", async () => {
    const hang = (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const result = await client(hang, undefined, 10).dryQuote(INPUT);
    expect(result.outcome).toBe("check_failed");
  });

  it("an error's detail doesn't reach the result", async () => {
    const fetch = vi.fn(async () => Promise.reject(new Error(`bad ${KEY}`)));
    expect(JSON.stringify(await client(fetch).dryQuote(INPUT))).not.toContain(KEY);
  });
});

describe("no secrets", () => {
  it("log events hold only status, outcome and timing", async () => {
    const events: OneClickLogEvent[] = [];
    await client(accepted(), (e) => events.push(e)).dryQuote(INPUT);
    expect(Object.keys(events[0] as object).sort()).toEqual(["ms", "outcome", "status"]);
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain(INPUT.recipient);
  });

  it("no fixture holds a JWT, an API key or a redacted header", () => {
    const dir = fileURLToPath(fixtureDir);
    for (const name of readdirSync(dir)) {
      const text = readFileSync(new URL(name, fixtureDir), "utf8");
      expect(text).not.toMatch(
        /eyJ[A-Za-z0-9_-]{10,}\.|sk-[A-Za-z0-9]{8,}|x-api-key|authorization/i,
      );
    }
  });
});
