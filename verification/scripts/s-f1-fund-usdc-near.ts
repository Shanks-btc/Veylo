// Spike S-F1 (slice W6, part 3a): fund a treasury with USDC on NEAR through a 1Click deposit address.
// This is the recommended funding path, and no same-asset quote (USDC on NEAR in, USDC on the
// treasury's Intents balance out) has ever been made. A dev NEAR account sends USDC to the deposit
// address from a live EXACT_INPUT quote; NEAR Intents credits the treasury's Intents balance.
// At most 0.50 USDC. If 1Click refuses the same-asset quote, the run stops there, and that refusal is
// the finding (the fallback is a direct `ft_transfer_call` of USDC to `intents.near`).
//
// MAINNET. NOT RUN in slice W6: it sends real USDC, so it needs the founder's explicit approval,
// given by setting S_F1_FOUNDER_APPROVED=yes for the one run. Stops on any error, with no retries.
// Never prints or records a secret key.
// Run (only after approval): npx tsx scripts/s-f1-fund-usdc-near.ts
import { Account, JsonRpcProvider, nearToYocto, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { record } from "../_util.js";
import { USDC_NEAR_CONTRACT, USDC_NEAR_TOKEN, approve, intentsBalance, liveQuote, pollStatus, required, stop, viewText } from "./w6-spike.js";

approve("S_F1_FOUNDER_APPROVED", "S-F1 sends real USDC on mainnet to a 1Click deposit address");
const JWT = required("ONECLICK_JWT");
const TREASURY = required("TREASURY_ACCOUNT_ID");
const FUNDER = required("FUNDER_NEAR_ACCOUNT_ID"); // a dev account holding USDC and a little NEAR
const FUNDER_KEY = required("FUNDER_NEAR_SECRET_KEY");
const AMOUNT = 450_000n; // 0.45 USDC (6 decimals); the cap is 0.50
const CAP = 500_000n;
if (AMOUNT > CAP) stop("the amount is above the 0.50 USDC cap");

const before = {
  treasuryUsdc: await intentsBalance(TREASURY, USDC_NEAR_TOKEN),
  funderUsdc: await viewText(USDC_NEAR_CONTRACT, "ft_balance_of", { account_id: FUNDER }),
};
record("S-F1", "balances-before", before);
if (before.treasuryUsdc === undefined || before.funderUsdc === undefined) stop("could not read the starting balances");
if (BigInt(before.funderUsdc) < AMOUNT) stop("the funder account doesn't hold 0.45 USDC");

const { quote, raw } = await liveQuote(JWT, {
  swapType: "EXACT_INPUT",
  originAsset: USDC_NEAR_TOKEN,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: USDC_NEAR_TOKEN,
  amount: AMOUNT.toString(),
  recipient: TREASURY,
  recipientType: "INTENTS",
  refundTo: FUNDER,
  refundType: "ORIGIN_CHAIN",
  deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
});
record("S-F1", "quote", raw);
if (quote.amountIn !== AMOUNT.toString()) stop(`amountIn ${quote.amountIn} is not the requested ${AMOUNT}`);

const provider = new JsonRpcProvider({ url: "https://rpc.fastnear.com" });
const funder = new Account(FUNDER, provider, FUNDER_KEY as KeyPairString);
const storage = await viewText(USDC_NEAR_CONTRACT, "storage_balance_of", { account_id: quote.depositAddress });
if (storage === null || storage === undefined) {
  const reg = await funder.callFunctionRaw({
    contractId: USDC_NEAR_CONTRACT,
    methodName: "storage_deposit",
    args: { account_id: quote.depositAddress, registration_only: true },
    gas: teraToGas("30"),
    deposit: nearToYocto("0.00125"),
  });
  record("S-F1", "storage-deposit", reg);
}
const sent = await funder.callFunctionRaw({
  contractId: USDC_NEAR_CONTRACT,
  methodName: "ft_transfer",
  args: { receiver_id: quote.depositAddress, amount: quote.amountIn },
  gas: teraToGas("30"),
  deposit: 1n, // NEP-141 asks for exactly 1 yoctoNEAR
});
record("S-F1", "transfer", { depositAddress: quote.depositAddress, amountIn: quote.amountIn, outcome: sent });

const status = await pollStatus(quote.depositAddress, 30, (line) => console.log(line));
await new Promise((resolve) => setTimeout(resolve, 60_000));
const after = {
  treasuryUsdc: await intentsBalance(TREASURY, USDC_NEAR_TOKEN),
  funderUsdc: await viewText(USDC_NEAR_CONTRACT, "ft_balance_of", { account_id: FUNDER }),
};
const delta = after.treasuryUsdc !== undefined ? BigInt(after.treasuryUsdc) - BigInt(before.treasuryUsdc) : undefined;
const pass = status.last === "SUCCESS" && delta !== undefined && quote.minAmountOut !== undefined && delta >= BigInt(quote.minAmountOut);
record("S-F1", "result", { terminal: status.terminal, lastStatus: status.last, before, after, treasuryUsdcDelta: delta?.toString(), minAmountOut: quote.minAmountOut, pass });
console.log(`${pass ? "PASS" : "NOT PASSED"}: status ${String(status.last)}; treasury USDC ${before.treasuryUsdc} -> ${after.treasuryUsdc}`);
