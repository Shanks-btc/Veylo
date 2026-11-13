// Spike S-EW (slice W6, addendum): does a Veylo embedded wallet work end to end on mainnet? The
// wallet's account is an implicit 64-hex account derived from its own key. The spike (1) funds that
// account's NEAR Intents balance with 0.10 USDC from a dev treasury, then (2) waits while the founder,
// in the app, signs a transfer of that USDC out with the embedded wallet, and (3) checks the balance
// moved: proof that NEAR Intents accepts an intent signed by the embedded key.
//
// MAINNET. NOT RUN in slice W6: it moves real funds, so it needs the founder's explicit approval,
// given by setting S_EW_FOUNDER_APPROVED=yes for the one run. Use a THROWAWAY wallet made only for
// this test (never a personal wallet); the script needs only its public account id, never its key or
// recovery phrase. Stops on any error, with no retries.
// Run (only after approval): npx tsx scripts/s-ew-embedded-wallet.ts
import { record } from "../_util.js";
import { USDC_NEAR_TOKEN, approve, intentsBalance, liveQuote, pollStatus, required, signAndSubmit, stop } from "./w6-spike.js";

approve("S_EW_FOUNDER_APPROVED", "S-EW moves real USDC on mainnet to a throwaway embedded wallet");
const JWT = required("ONECLICK_JWT");
const TREASURY = required("TREASURY_ACCOUNT_ID"); // the dev treasury that funds the test
const SECRET = required("TREASURY_SECRET_KEY");
const WALLET = required("EW_ACCOUNT_ID"); // the throwaway embedded wallet's implicit account (64 hex)
if (!/^[0-9a-f]{64}$/.test(WALLET)) stop("EW_ACCOUNT_ID must be an implicit account: 64 lowercase hex characters");
if (WALLET === TREASURY) stop("the test wallet must not be the treasury");
const AMOUNT = 100_000n; // 0.10 USDC (6 decimals)
const CAP = 100_000n;

const before = { treasury: await intentsBalance(TREASURY, USDC_NEAR_TOKEN), wallet: await intentsBalance(WALLET, USDC_NEAR_TOKEN) };
record("S-EW", "balances-before", before);
if (before.treasury === undefined || before.wallet === undefined) stop("could not read the starting balances");
if (BigInt(before.treasury) < AMOUNT) stop("the dev treasury holds less than 0.10 USDC");

// 1. Fund: the treasury moves 0.10 USDC to the wallet's Intents balance (an internal transfer).
const { quote, raw } = await liveQuote(JWT, {
  swapType: "EXACT_OUTPUT",
  originAsset: USDC_NEAR_TOKEN,
  depositType: "INTENTS",
  destinationAsset: USDC_NEAR_TOKEN,
  amount: AMOUNT.toString(),
  recipient: WALLET,
  recipientType: "INTENTS",
  refundTo: TREASURY,
  refundType: "INTENTS",
  deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
});
record("S-EW", "fund-quote", raw);
if (quote.amountOut !== AMOUNT.toString()) stop(`amountOut ${quote.amountOut} is not the requested ${AMOUNT}`);
if (BigInt(quote.amountIn) > CAP) stop("amountIn is above the 0.10 USDC cap");
const intentHash = await signAndSubmit({ jwt: JWT, treasury: TREASURY, secretKey: SECRET, depositAddress: quote.depositAddress, token: USDC_NEAR_TOKEN, capUnits: CAP });
const funded = await pollStatus(quote.depositAddress, 15, (line) => console.log(line));
record("S-EW", "funded", { intentHash, status: funded.last, transitions: funded.transitions });
if (funded.last !== "SUCCESS") stop(`the funding did not succeed (status ${String(funded.last)})`);
const mid = await intentsBalance(WALLET, USDC_NEAR_TOKEN);
console.log(`The wallet now holds ${mid} (smallest units) on NEAR Intents.`);

// 2. The founder signs a transfer of it out in the app, with the Veylo wallet (the app shows a cash-out
// or a transfer of the 0.10 USDC to an address the founder controls). The spike waits for the balance to move.
console.log("NOW: in the app, sign in with the throwaway Veylo wallet and move the 0.10 USDC out. Waiting up to 20 minutes.");
const until = Date.now() + 20 * 60_000;
let after: string | undefined = mid;
while (Date.now() < until) {
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  after = await intentsBalance(WALLET, USDC_NEAR_TOKEN);
  if (after !== undefined && mid !== undefined && BigInt(after) < BigInt(mid)) break;
}
const moved = after !== undefined && mid !== undefined && BigInt(after) < BigInt(mid);
record("S-EW", "result", { before, fundedBalance: mid, afterBalance: after, movedOut: moved, pass: moved });
console.log(`${moved ? "PASS" : "NOT PASSED"}: the wallet's balance ${mid} -> ${after}`);
