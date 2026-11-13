// Spike S-NR (slice W6, part 3b): one payout of NEAR from a treasury's USDC on NEAR Intents to a NEAR
// named account, EXACT_OUTPUT, at most 0.10 USD of NEAR. The question it answers: what does the
// recipient actually receive, native NEAR on their account or wrapped NEAR (wrap.near, an NEP-141
// token)? Both balances are read before and after.
//
// MAINNET. NOT RUN in slice W6: it moves real funds, so it needs the founder's explicit approval,
// given by setting S_NR_FOUNDER_APPROVED=yes for the one run. Stops on any error, with no retries.
// Refuses to sign unless the intent's debit is provably within the cap. Never prints or records a
// secret key.
// Run (only after approval): npx tsx scripts/s-nr-near-payout.ts
import { record } from "../_util.js";
import {
  NAMED_ACCOUNT, USDC_NEAR_TOKEN, WNEAR_TOKEN, approve, intentsBalance, listedPrice, liveQuote, nativeBalance, pollStatus, required, signAndSubmit, stop, unitsForUsd, usdMicrosFor, viewText,
} from "./w6-spike.js";

approve("S_NR_FOUNDER_APPROVED", "S-NR is a mainnet payout of NEAR");
const JWT = required("ONECLICK_JWT");
const TREASURY = required("TREASURY_ACCOUNT_ID");
const SECRET = required("TREASURY_SECRET_KEY");
const RECIPIENT = required("CONTRACTOR_NEAR_ACCOUNT");
if (!NAMED_ACCOUNT.test(RECIPIENT)) stop("CONTRACTOR_NEAR_ACCOUNT must be a NEAR named account (*.near)");
if (RECIPIENT === TREASURY) stop("the recipient must not be the treasury");
const CAP_USDC = 100_000n; // the treasury may spend at most 0.10 USDC (6 decimals)
const TARGET_USD_MICROS = 80_000n; // 0.08 USD of NEAR leaves room for the swap fee under the cap

const price = await listedPrice(JWT, WNEAR_TOKEN);
const amount = unitsForUsd(TARGET_USD_MICROS, price, 24);
if (usdMicrosFor(amount, price, 24) > CAP_USDC) stop("the sized amount is above the cap");

const read = async () => ({
  treasuryUsdc: await intentsBalance(TREASURY, USDC_NEAR_TOKEN),
  recipientNative: await nativeBalance(RECIPIENT),
  recipientWrapped: await viewText("wrap.near", "ft_balance_of", { account_id: RECIPIENT }),
});
const before = await read();
record("S-NR", "balances-before", before);
if (before.treasuryUsdc === undefined || before.recipientNative === undefined || before.recipientWrapped === undefined) stop("could not read the starting balances");
console.log(`NEAR price ${price} USD; requesting ${amount} yoctoNEAR (about 0.08 USD)`);

// EXACT_OUTPUT: the recipient must receive exactly `amount` of NEAR; the treasury pays the USDC.
const { quote, raw } = await liveQuote(JWT, {
  swapType: "EXACT_OUTPUT",
  originAsset: USDC_NEAR_TOKEN,
  depositType: "INTENTS",
  destinationAsset: WNEAR_TOKEN,
  amount: amount.toString(),
  recipient: RECIPIENT,
  recipientType: "DESTINATION_CHAIN",
  refundTo: TREASURY,
  refundType: "INTENTS",
  deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
});
record("S-NR", "quote", raw);
if (quote.amountOut !== amount.toString()) stop(`amountOut ${quote.amountOut} is not the requested ${amount}`);
if (BigInt(quote.amountIn) > CAP_USDC) stop(`amountIn ${quote.amountIn} is above the 0.10 USDC cap`);
if (BigInt(quote.amountIn) > BigInt(before.treasuryUsdc)) stop("amountIn is above the treasury's Intents balance");

const intentHash = await signAndSubmit({ jwt: JWT, treasury: TREASURY, secretKey: SECRET, depositAddress: quote.depositAddress, token: USDC_NEAR_TOKEN, capUnits: CAP_USDC });
console.log(`Submitted intent ${intentHash}`);
const status = await pollStatus(quote.depositAddress, 30, (line) => console.log(line));
await new Promise((resolve) => setTimeout(resolve, 60_000));
const after = await read();
const nativeDelta = after.recipientNative && before.recipientNative ? BigInt(after.recipientNative) - BigInt(before.recipientNative) : undefined;
const wrappedDelta = after.recipientWrapped && before.recipientWrapped ? BigInt(after.recipientWrapped) - BigInt(before.recipientWrapped) : undefined;
const arrivedAs = nativeDelta !== undefined && nativeDelta > 0n ? "native NEAR" : wrappedDelta !== undefined && wrappedDelta > 0n ? "wrapped NEAR (wrap.near)" : "nothing observed";
record("S-NR", "result", {
  terminal: status.terminal, lastStatus: status.last, intentHash, before, after,
  nativeDelta: nativeDelta?.toString(), wrappedDelta: wrappedDelta?.toString(), requested: amount.toString(), arrivedAs,
});
console.log(`Status ${String(status.last)}; the recipient received: ${arrivedAs} (native delta ${nativeDelta}, wrapped delta ${wrappedDelta}, requested ${amount})`);
