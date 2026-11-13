// The contractor's cash-out checks (D3), on the recorded T5b quote and payload (a real quote with
// NEAR Intents' real signature). The recorded refund account stands in for the contractor's account.
import { describe, expect, it } from "vitest";
import { nonceSaltHex } from "@veylo/intents";
import payloadFile from "../demo/recorded/payload-t5b.json";
import quoteFile from "../demo/recorded/quote-t5b.json";
import { checkCashOut } from "./cash-out";

const QUOTE = quoteFile.body as unknown as {
  quote: Record<string, string>;
  quoteRequest: Record<string, string>;
};
const PAYLOAD = payloadFile.payload as { message: string; nonce: string; recipient: string };
const SALT = nonceSaltHex(PAYLOAD.nonce) as string;
const CONTRACTOR = QUOTE.quoteRequest.refundTo as string;
const TYPED = QUOTE.quoteRequest.recipient as string;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const check = (over: Partial<Parameters<typeof checkCashOut>[0]> = {}) =>
  checkCashOut({
    quote: QUOTE,
    payload: PAYLOAD,
    contractorAccountId: CONTRACTOR,
    recipient: TYPED,
    amount: "0.100000",
    saltHex: SALT,
    ...over,
  });
const failed = (r: ReturnType<typeof check>) =>
  r.checks.filter((c) => !c.passed).map((c) => c.label);

describe("contractor cash-out checks", () => {
  it("passes a real signed quote that pays the typed address, for the amount asked", () => {
    const r = check();
    expect(r.passed).toBe(true);
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  it("refuses a quote that pays another address than the one typed", () => {
    const r = check({ recipient: "0x1111111111111111111111111111111111111111" });
    expect(r.passed).toBe(false);
    expect(failed(r)).toEqual(["It pays the address you typed"]);
  });

  it("refuses a quote altered after NEAR Intents signed it, even to the address typed", () => {
    const q = clone(QUOTE);
    q.quoteRequest.recipient = "0x1111111111111111111111111111111111111111";
    const r = check({ quote: q, recipient: "0x1111111111111111111111111111111111111111" });
    expect(failed(r)).toContain("The quote is signed by NEAR Intents");
    expect(r.passed).toBe(false);
  });

  it("refuses a different amount than the one asked", () => {
    expect(failed(check({ amount: "0.200000" }))).toContain(
      "The amount, fee, refund and payload are right",
    );
  });

  it("refuses when the refund wouldn't come back to the contractor", () => {
    expect(failed(check({ contractorAccountId: "someone-else.near" }))).toContain(
      "The amount, fee, refund and payload are right",
    );
  });

  it("refuses a payload that doesn't match the quote", () => {
    const p = { ...PAYLOAD, message: PAYLOAD.message.replace("105882", "999999") };
    expect(check({ payload: p }).passed).toBe(false);
  });

  it("refuses a missing or unsigned quote", () => {
    expect(check({ quote: undefined }).passed).toBe(false);
    expect(
      check({ quote: { quote: {}, quoteRequest: {}, signature: "x", timestamp: "x" } }).passed,
    ).toBe(false);
  });
});
