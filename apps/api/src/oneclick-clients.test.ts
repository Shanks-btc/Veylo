// The 1Click clients of a deployment (W7.3): with the partner key everything is on; without it only
// the two calls 1Click serves keyless (a funding quote and a deposit's status) work, and every other
// call is refused before any network request, so nothing else runs unauthenticated by accident.
import { readFileSync } from "node:fs";
import { OneClickError } from "@veylo/intents";
import { describe, expect, it, vi } from "vitest";
import { createOneClickClients } from "./oneclick-clients.js";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../packages/intents/src/fixtures/treasury-${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as { status: number; body: unknown };

const TREASURY = "a87a0e4f93085edbe787aa4530021045f426c8fbc500a7c1dbd729dc4f8151ce";
const REFUND = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
const BSC_USDT = "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g";
const funding = {
  treasuryAccountId: TREASURY,
  recipient: TREASURY,
  originAsset: BSC_USDT,
  amount: "2000000000000000000",
  refundAddress: REFUND,
  deadline: new Date("2026-11-05T15:41:27.252Z"),
};

function recorder(...replies: { status: number; body: unknown }[]) {
  const headers: Record<string, string>[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    headers.push(
      Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
    );
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, spy: fetch, headers };
}

describe("with the partner key", () => {
  it("is connected, and sends the key on a funding quote", async () => {
    const r = recorder(fixture("funding-dry"), fixture("funding-live"));
    const clients = createOneClickClients({
      partnerKey: "partner-key-sentinel",
      quotePublicKey: "unused",
      fetch: r.fetch,
    });
    expect(clients.connected).toBe(true);
    expect(clients.fundingQuotes).toBe(true);
    await clients.oneclickTreasury.createFundingQuote(funding);
    for (const h of r.headers) expect(h["x-api-key"]).toBe("partner-key-sentinel");
  });
});

describe("without the partner key", () => {
  const build = (r: ReturnType<typeof recorder>) =>
    createOneClickClients({ partnerKey: undefined, quotePublicKey: "unused", fetch: r.fetch });

  it("is not connected for payouts, but funding is on", () => {
    const clients = build(recorder());
    expect(clients.connected).toBe(false);
    expect(clients.fundingQuotes).toBe(true);
  });

  it("makes a funding quote and reads a deposit's status, sending no key at all", async () => {
    const r = recorder(fixture("funding-dry"), fixture("funding-live"), {
      status: 200,
      body: { status: "PENDING_DEPOSIT" },
    });
    const { oneclickTreasury } = build(r);
    const quote = await oneclickTreasury.createFundingQuote(funding);
    expect(quote.depositAddress).toBeTruthy();
    expect(await oneclickTreasury.status(quote.depositAddress!)).toMatchObject({
      status: "PENDING_DEPOSIT",
    });
    expect(r.headers.length).toBe(3);
    for (const h of r.headers) {
      expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("x-api-key");
      expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("authorization");
    }
  });

  it("refuses everything else before any request: payout quotes, shield, intents, sessions, balances", async () => {
    const r = recorder();
    const { oneclickTreasury: c, oneclick } = build(r);
    const calls: Promise<unknown>[] = [
      c.referencePrice("nep141:x"),
      c.createPayoutQuote({} as never),
      c.createShieldQuote({} as never),
      c.generateSwapTransferIntent({} as never),
      c.submitIntent({} as never),
      c.authenticate({} as never),
      c.refresh("t"),
      c.balances("t"),
    ];
    for (const call of calls)
      await expect(call).rejects.toMatchObject({
        kind: "not_connected",
        detail: "Live quotes are not connected yet",
      });
    expect(await oneclick.dryQuote({} as never)).toMatchObject({ outcome: "check_failed" });
    expect(r.spy).not.toHaveBeenCalled();
    expect(OneClickError).toBeTruthy();
  });
});
