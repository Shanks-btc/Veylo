// The 1Click clients for a process, from its configuration (W7, W7.3). With the partner key they are
// the real clients. Without it, every live-quote feature that needs the key (payout quotes, the
// private balance, the sessions) is the disconnected client: it never touches the network and
// refuses with "Live quotes are not connected yet", so it fails closed.
//
// Funding is the one exception (W7.3). 1Click serves a funding quote, and the status of the deposit
// it quoted, to a caller with no key (docs.near-intents.org/resources/fees: without a key 1Click
// adds 0.25% to the quote's fee; the quote is still signed, and the browser still checks the
// signature and that the funds go to the owner's own treasury before showing an address). So
// without a key a company can still fund its treasury, and nothing else is switched on.
import {
  createOneClickDryClient,
  createOneClickTreasuryClient,
  disconnectedDryClient,
  disconnectedTreasuryClient,
  type OneClickTreasuryClient,
} from "@veylo/intents";

export function createOneClickClients(options: {
  partnerKey: string | undefined;
  quotePublicKey: string;
  fetch: typeof globalThis.fetch;
}) {
  const { partnerKey: apiKey, quotePublicKey, fetch } = options;
  if (apiKey) {
    return {
      connected: true as const,
      fundingQuotes: true as const,
      oneclick: createOneClickDryClient({ apiKey, fetch }),
      oneclickTreasury: createOneClickTreasuryClient({ apiKey, fetch, quotePublicKey }),
    };
  }
  const keyless = createOneClickTreasuryClient({ fetch, quotePublicKey });
  const fundingOnly: OneClickTreasuryClient = {
    ...disconnectedTreasuryClient,
    createFundingQuote: keyless.createFundingQuote,
    status: keyless.status,
  };
  return {
    connected: false as const,
    fundingQuotes: true as const,
    oneclick: disconnectedDryClient,
    oneclickTreasury: fundingOnly,
  };
}
