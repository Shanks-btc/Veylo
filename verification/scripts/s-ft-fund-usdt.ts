// Spike S-FT (slice W6, part 3a addendum): fund a treasury with USDT on NEAR, converted to USDC by
// 1Click. A dev NEAR account sends USDT (NEP-141, usdt.tether-token.near) to a 1Click deposit
// address from a live EXACT_INPUT quote; NEAR Intents converts it and credits USDC to the treasury's
// Intents balance. At most 0.50 USDT.
//
// MAINNET. NOT RUN in slice W6: it sends real USDT, so it needs the founder's explicit approval,
// given by setting S_FT_FOUNDER_APPROVED=yes for the one run. Stops on any error, with no retries.
// Never prints or records a secret key.
// Run (only after approval): npx tsx scripts/s-ft-fund-usdt.ts
import { Account, JsonRpcProvider, nearToYocto, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { record } from "../_util.js";
import { USDC_NEAR_TOKEN, USDT_NEAR_TOKEN, approve, intentsBalance, liveQuote, pollStatus, required, stop, viewText } from "./w6-spike.js";

approve("S_FT_FOUNDER_APPROVED", "S-FT sends real USDT on mainnet to a 1Click deposit address");
const JWT = required("ONECLICK_JWT");
const TREASURY = required("TREASURY_ACCOUNT_ID");
const FUNDER = required("FUNDER_NEAR_ACCOUNT_ID"); // a dev account holding USDT and a little NEAR
const FUNDER_KEY = required("FUNDER_NEAR_SECRET_KEY");
const USDT_CONTRACT = "usdt.tether-token.near";
const AMOUNT = 450_000n; // 0.45 USDT (6 decimals); the cap is 0.50
const CAP = 500_000n;
if (AMOUNT > CAP) stop("the amount is above the 0.50 USDT cap");

const before = {
  treasuryUsdc: await intentsBalance(TREASURY, USDC_NEAR_TOKEN),
  funderUsdt: await viewText(USDT_CONTRACT, "ft_balance_of", { account_id: FUNDER }),
};
record("S-FT", "balances-before", before);
if (before.treasuryUsdc === undefined || before.funderUsdt === undefined) stop("could not read the starting balances");
if (BigInt(before.funderUsdt) < AMOUNT) stop("the funder account doesn't hold 0.45 USDT");

const { quote, raw } = await liveQuote(JWT, {
  swapType: "EXACT_INPUT",
  originAsset: USDT_NEAR_TOKEN,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: USDC_NEAR_TOKEN,
  amount: AMOUNT.toString(),
  recipient: TREASURY,
  recipientType: "INTENTS",
  refundTo: FUNDER,
  refundType: "ORIGIN_CHAIN",
  deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
});
record("S-FT", "quote", raw);
if (quote.amountIn !== AMOUNT.toString()) stop(`amountIn ${quote.amountIn} is not the requested ${AMOUNT}`);

const provider = new JsonRpcProvider({ url: "https://rpc.fastnear.com" });
const funder = new Account(FUNDER, provider, FUNDER_KEY as KeyPairString);
// A NEAR account must be registered with the token contract before it can hold the token. If the
// deposit address isn't, register it (about 0.00125 NEAR from the funder), then send.
const storage = await viewText(USDT_CONTRACT, "storage_balance_of", { account_id: quote.depositAddress });
if (storage === null || storage === undefined) {
  const reg = await funder.callFunctionRaw({
    contractId: USDT_CONTRACT,
    methodName: "storage_deposit",
    args: { account_id: quote.depositAddress, registration_only: true },
    gas: teraToGas("30"),
    deposit: nearToYocto("0.00125"),
  });
  record("S-FT", "storage-deposit", reg);
}
const sent = await funder.callFunctionRaw({
  contractId: USDT_CONTRACT,
  methodName: "ft_transfer",
  args: { receiver_id: quote.depositAddress, amount: quote.amountIn },
  gas: teraToGas("30"),
  deposit: 1n, // NEP-141 asks for exactly 1 yoctoNEAR
});
record("S-FT", "transfer", { depositAddress: quote.depositAddress, amountIn: quote.amountIn, outcome: sent });

const status = await pollStatus(quote.depositAddress, 30, (line) => console.log(line));
await new Promise((resolve) => setTimeout(resolve, 60_000));
const after = {
  treasuryUsdc: await intentsBalance(TREASURY, USDC_NEAR_TOKEN),
  funderUsdt: await viewText(USDT_CONTRACT, "ft_balance_of", { account_id: FUNDER }),
};
const delta = after.treasuryUsdc !== undefined ? BigInt(after.treasuryUsdc) - BigInt(before.treasuryUsdc) : undefined;
const pass = status.last === "SUCCESS" && delta !== undefined && quote.minAmountOut !== undefined && delta >= BigInt(quote.minAmountOut);
record("S-FT", "result", { terminal: status.terminal, lastStatus: status.last, before, after, treasuryUsdcDelta: delta?.toString(), minAmountOut: quote.minAmountOut, pass });
console.log(`${pass ? "PASS" : "NOT PASSED"}: status ${String(status.last)}; treasury USDC ${before.treasuryUsdc} -> ${after.treasuryUsdc}`);
