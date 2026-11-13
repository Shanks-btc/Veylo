// Spike S-F2 (slice W6, part 3a): fund a treasury with NEAR, converted to USDC by 1Click.
// A dev NEAR account sends NEAR to a 1Click deposit address from a live EXACT_INPUT quote; NEAR
// Intents converts it and credits USDC to the treasury's Intents balance. At most 0.50 USD of NEAR.
//
// MAINNET. NOT RUN in slice W6: it sends real NEAR, so it needs the founder's explicit approval,
// given by setting S_F2_FOUNDER_APPROVED=yes for the one run. Stops on any error, with no retries.
// Sizes the amount from 1Click's listed price and refuses unless its USD value is within the cap.
// Never prints or records a secret key.
// Run (only after approval): npx tsx scripts/s-f2-fund-near.ts
import { Account, JsonRpcProvider } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { record } from "../_util.js";
import {
  USDC_NEAR_TOKEN, WNEAR_TOKEN, approve, intentsBalance, listedPrice, liveQuote, nativeBalance, pollStatus, required, stop, unitsForUsd, usdMicrosFor,
} from "./w6-spike.js";

approve("S_F2_FOUNDER_APPROVED", "S-F2 sends real NEAR on mainnet to a 1Click deposit address");
const JWT = required("ONECLICK_JWT");
const TREASURY = required("TREASURY_ACCOUNT_ID"); // the Intents account that receives the USDC
const FUNDER = required("FUNDER_NEAR_ACCOUNT_ID"); // a dev account holding a little NEAR (never a personal wallet)
const FUNDER_KEY = required("FUNDER_NEAR_SECRET_KEY");
const CAP_USD_MICROS = 500_000n; // 0.50 USD
const TARGET_USD_MICROS = 450_000n; // leaves room for the price moving before the quote

const price = await listedPrice(JWT, WNEAR_TOKEN);
const amount = unitsForUsd(TARGET_USD_MICROS, price, 24);
if (usdMicrosFor(amount, price, 24) > CAP_USD_MICROS) stop("the sized amount is above the 0.50 USD cap");
console.log(`NEAR price ${price} USD; sending ${amount} yoctoNEAR (about 0.45 USD)`);

const before = { treasuryUsdc: await intentsBalance(TREASURY, USDC_NEAR_TOKEN), funderNear: await nativeBalance(FUNDER) };
record("S-F2", "balances-before", before);
if (before.treasuryUsdc === undefined || before.funderNear === undefined) stop("could not read the starting balances");
if (BigInt(before.funderNear) < amount + 10n ** 22n) stop("the funder account doesn't hold enough NEAR (amount plus 0.01 NEAR for the fee)");

// EXACT_INPUT: the funder spends exactly `amount`; the treasury receives USDC on its Intents balance.
const { quote, raw } = await liveQuote(JWT, {
  swapType: "EXACT_INPUT",
  originAsset: WNEAR_TOKEN,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: USDC_NEAR_TOKEN,
  amount: amount.toString(),
  recipient: TREASURY,
  recipientType: "INTENTS",
  refundTo: FUNDER,
  refundType: "ORIGIN_CHAIN",
  deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
});
record("S-F2", "quote", raw);
if (quote.amountIn !== amount.toString()) stop(`amountIn ${quote.amountIn} is not the requested ${amount}`);
if (usdMicrosFor(BigInt(quote.amountIn), price, 24) > CAP_USD_MICROS) stop("the quote's amountIn is above the cap");

const provider = new JsonRpcProvider({ url: "https://rpc.fastnear.com" });
const funder = new Account(FUNDER, provider, FUNDER_KEY as KeyPairString);
const outcome = await funder.transfer({ receiverId: quote.depositAddress, amount: BigInt(quote.amountIn) });
record("S-F2", "transfer", { depositAddress: quote.depositAddress, amountIn: quote.amountIn, outcome });
console.log(`Sent ${quote.amountIn} yoctoNEAR to ${quote.depositAddress}`);

const status = await pollStatus(quote.depositAddress, 30, (line) => console.log(line));
await new Promise((resolve) => setTimeout(resolve, 60_000));
const after = { treasuryUsdc: await intentsBalance(TREASURY, USDC_NEAR_TOKEN), funderNear: await nativeBalance(FUNDER) };
const delta = after.treasuryUsdc !== undefined ? BigInt(after.treasuryUsdc) - BigInt(before.treasuryUsdc) : undefined;
const pass = status.last === "SUCCESS" && delta !== undefined && quote.minAmountOut !== undefined && delta >= BigInt(quote.minAmountOut);
record("S-F2", "result", { terminal: status.terminal, lastStatus: status.last, before, after, treasuryUsdcDelta: delta?.toString(), minAmountOut: quote.minAmountOut, pass });
console.log(`${pass ? "PASS" : "NOT PASSED"}: status ${String(status.last)}; treasury USDC ${before.treasuryUsdc} -> ${after.treasuryUsdc}`);
