// ARCHITECTURE §11.3. Run by verify.mjs when ONECLICK_PARTNER_KEY is set. A live dry quote per route:
// free, moves nothing. Prints one JSON line, and never the key.
import { PAYOUT_ROUTES, type PayoutRoute } from "@veylo/core";
import { acceptanceQuote, createOneClickDryClient } from "@veylo/intents";

// The dev recipients and dev treasury from the T5, T5b and T5c mainnet payouts: public evidence.
const RECIPIENTS: Record<PayoutRoute["addressKind"], string> = {
  evm: "0xAf780910c0E7D41430D4615A437676a87a332C8C",
  solana: "3DxAMQpfLiMPN8e91HoJGAFUzEYRSVMd3LR5crAYEraz",
  near: "3b66a6e2098020b8a3a8a8e273291e8ab1869ee042504e297f19f4d54f7f9812",
};
const DEV_TREASURY = "a87a0e4f93085edbe787aa4530021045f426c8fbc500a7c1dbd729dc4f8151ce";

const client = createOneClickDryClient({
  apiKey: process.env.ONECLICK_PARTNER_KEY as string,
  fetch: globalThis.fetch,
});

const results = await Promise.all(
  PAYOUT_ROUTES.map(async (route) => {
    const result = await client.dryQuote(
      acceptanceQuote({
        route,
        recipient: RECIPIENTS[route.addressKind],
        treasuryAccountId: DEV_TREASURY,
        deadline: new Date(Date.now() + 10 * 60 * 1000),
      }),
    );
    return {
      route: route.id,
      outcome: result.outcome,
      detail:
        result.outcome === "accepted"
          ? `amountIn ${result.amountIn}, delivery fee ${result.withdrawFee}`
          : result.reason,
    };
  }),
);
console.log(JSON.stringify(results));
