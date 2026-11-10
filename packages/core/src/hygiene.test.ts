import { describe, expect, it } from "vitest";
import { addressHygieneWarnings, type HygieneDestination } from "./hygiene.js";
import { getPayoutRoute, PAYOUT_ROUTE_IDS, PAYOUT_ROUTES, TREASURY_ASSET_ID } from "./routes.js";

const direct = (over: Partial<HygieneDestination> = {}): HygieneDestination => ({
  address: "0xAAA",
  payoutMode: "direct",
  status: "superseded",
  receivedPublicPayout: false,
  ...over,
});
const priv = (over: Partial<HygieneDestination> = {}): HygieneDestination => ({
  address: "bob.near",
  payoutMode: "private",
  status: "active",
  receivedPublicPayout: false,
  ...over,
});
const codes = (input: Parameters<typeof addressHygieneWarnings>[0]) =>
  addressHygieneWarnings(input).map((w) => `${w.code}:${w.address}`);

describe("switching Direct to Private", () => {
  it("warns when a publicly paid address is on file", () => {
    expect(codes({ destinations: [direct({ receivedPublicPayout: true }), priv()] })).toEqual([
      "SWITCH_TO_PRIVATE_WITH_PUBLIC_ADDRESS:0xAAA",
    ]);
  });

  it("also warns while the private destination is still a candidate", () => {
    const destinations = [direct({ receivedPublicPayout: true }), priv({ status: "candidate" })];
    expect(codes({ destinations })).toHaveLength(1);
  });

  it("is silent if the old address was never publicly paid", () => {
    expect(codes({ destinations: [direct(), priv()] })).toEqual([]);
  });

  it("is silent while the contractor stays Direct", () => {
    expect(codes({ destinations: [direct({ receivedPublicPayout: true })] })).toEqual([]);
  });

  it("is silent if the private destination was itself superseded", () => {
    const destinations = [
      direct({ receivedPublicPayout: true, status: "active" }),
      priv({ status: "superseded" }),
    ];
    expect(codes({ destinations })).toEqual([]);
  });

  it("names a repeated address once", () => {
    const flagged = direct({ receivedPublicPayout: true });
    expect(codes({ destinations: [flagged, flagged, priv()] })).toHaveLength(1);
  });
});

describe("cash-out", () => {
  const destinations = [direct({ receivedPublicPayout: true, status: "active" })];

  it("warns on a flagged address", () => {
    expect(codes({ destinations, cashOutAddress: "0xAAA" })).toEqual([
      "CASH_OUT_TO_PUBLIC_ADDRESS:0xAAA",
    ]);
  });

  it("is silent on a fresh address", () => {
    expect(codes({ destinations, cashOutAddress: "0xFRESH" })).toEqual([]);
  });

  it("counts a flag on any row holding that address", () => {
    const rows = [direct({ status: "active" }), direct({ receivedPublicPayout: true })];
    expect(codes({ destinations: rows, cashOutAddress: "0xAAA" })).toHaveLength(1);
  });
});

describe("supported routes (L25)", () => {
  it("are exactly the four MVP routes", () => {
    expect(PAYOUT_ROUTES.map((r) => [r.id, r.payoutMode, r.decimals])).toEqual([
      ["usdc-base", "direct", 6],
      ["usdc-arbitrum", "direct", 6],
      ["usdc-solana", "direct", 6],
      ["usdc-near-confidential", "private", 6],
    ]);
  });

  it("have no Tron route", () => {
    expect(JSON.stringify(PAYOUT_ROUTES).toLowerCase()).not.toContain("tron");
  });

  it("only the private route pays the confidential balance, from the treasury asset", () => {
    const route = getPayoutRoute("usdc-near-confidential");
    expect(route).toMatchObject({
      assetId: TREASURY_ASSET_ID,
      recipientType: "CONFIDENTIAL_INTENTS",
      addressKind: "near",
    });
    for (const id of PAYOUT_ROUTE_IDS.filter((r) => r !== "usdc-near-confidential")) {
      expect(getPayoutRoute(id).recipientType).toBe("DESTINATION_CHAIN");
    }
  });

  it("refuses an unknown route", () => {
    expect(() => getPayoutRoute("usdc-tron" as never)).toThrow(RangeError);
  });
});
