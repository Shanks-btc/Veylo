import { describe, expect, it } from "vitest";
import { intentsExplorerUrl, txExplorerUrl } from "./index.js";

const NEAR = "7Mm6ctWXUEdAFFfbZuH8V4NNpKeggfTrQxRf1vkBKgx";
const EVM = "0xb8f7cd70174d9c3a951f137d1de7b76e4dcfdffd1fc11c78dc290b1fc0fb4aa8";
const SOL = "5".repeat(88);

describe("txExplorerUrl", () => {
  it.each([
    ["near", NEAR, `https://nearblocks.io/txns/${NEAR}`],
    ["base", EVM, `https://basescan.org/tx/${EVM}`],
    ["arb", EVM, `https://arbiscan.io/tx/${EVM}`],
    ["bsc", EVM, `https://bscscan.com/tx/${EVM}`],
  ] as const)("%s", (chain, hash, url) => {
    expect(txExplorerUrl(chain, hash)).toBe(url);
  });

  it.each([
    ["near", EVM],
    ["near", "short"],
    ["base", NEAR],
    ["base", "0x1234"],
    ["arb", `${EVM}/../evil`],
    ["sol", EVM],
    ["base", "javascript:alert(1)"],
  ] as const)("refuses a %s hash in the wrong form: %s", (chain, hash) => {
    expect(txExplorerUrl(chain, hash)).toBeUndefined();
  });
});

it("Solana links use the confirmed format https://explorer.solana.com/tx/<signature> (L39)", () => {
  expect(txExplorerUrl("sol", SOL)).toBe(`https://explorer.solana.com/tx/${SOL}`);
  expect(new URL(txExplorerUrl("sol", SOL) as string).pathname).toBe(`/tx/${SOL}`);
  expect(txExplorerUrl("sol", "5".repeat(85))).toBeUndefined();
  expect(txExplorerUrl("sol", `${"5".repeat(87)}0`)).toBeUndefined();
});

describe("intentsExplorerUrl", () => {
  it("links a deposit address", () => {
    const d = "f34735ee90d662ba39ffd56f434f45a1743d05b47c870f5a52ba1fd1e04410ae";
    expect(intentsExplorerUrl(d)).toBe(`https://explorer.near-intents.org/transactions/${d}`);
  });

  it.each(["", "a b", "x/../y", "<script>"])("refuses %j", (d) => {
    expect(intentsExplorerUrl(d)).toBeUndefined();
  });
});
