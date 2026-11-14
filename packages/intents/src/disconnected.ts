// 1Click clients for a deployment that has no partner key yet (W7). Nothing here touches the
// network: every call is refused with the same plain message, so each live-quote feature fails
// closed and says why, and nothing else is affected.
import { OneClickError, type OneClickTreasuryClient } from "./oneclick-treasury.js";
import type { OneClickDryClient } from "./oneclick.js";

/** The one sentence a person sees wherever a live quote would have been made. */
export const LIVE_QUOTES_OFF = "Live quotes are not connected yet";

const refuse = (): Promise<never> =>
  Promise.reject(new OneClickError("not_connected", LIVE_QUOTES_OFF));

/**
 * A dry-quote client that answers "could not check" for everything. `check_failed` is the existing
 * retryable outcome, so an address check shows this message and can be rechecked once a key is set.
 */
export const disconnectedDryClient: OneClickDryClient = {
  dryQuote: async () => ({ outcome: "check_failed", reason: LIVE_QUOTES_OFF }),
};

/** Every method of the treasury client, refused. The type makes a missing method a compile error. */
export const disconnectedTreasuryClient: OneClickTreasuryClient = {
  referencePrice: refuse,
  createPayoutQuote: refuse,
  createFundingQuote: refuse,
  createShieldQuote: refuse,
  generateSwapTransferIntent: refuse,
  submitIntent: refuse,
  status: refuse,
  authenticate: refuse,
  refresh: refuse,
  balances: refuse,
};
