// Linking a wallet to an email account (slice W6): the API serves a challenge, the browser checks it
// is exactly the link message for this wallet and this person before the wallet ever sees it, the
// wallet signs it (NEP-413), and the API verifies the signature and the key. Linking gives the email
// account a wallet to be the treasury; it gives the wallet's key no new power and the email no key.
import { base64 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ApiClient } from "../api/client.js";
import type { WalletSigner } from "../wallet/types.js";

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

const TTL_MS = 5 * 60_000;
const SKEW_MS = 2 * 60_000;
export const LINK_FIRST_LINE = "Link this wallet to Veylo";

/** Throws unless the challenge is exactly the API's wallet-link message for this wallet and person. */
export function checkLinkChallenge(
  challenge: { message: string; nonce: string; recipient: string },
  expected: { accountId: string; userId: string; authRecipient: string; now: Date },
): Uint8Array {
  if (challenge.recipient !== expected.authRecipient)
    throw new LinkError("challenge for another app");
  let nonce: Uint8Array;
  try {
    nonce = base64.decode(challenge.nonce);
  } catch {
    throw new LinkError("bad challenge nonce");
  }
  if (nonce.length !== 32) throw new LinkError("bad challenge nonce");
  const lines = challenge.message.split("\n");
  if (lines.length !== 6 || lines[0] !== LINK_FIRST_LINE)
    throw new LinkError("not a wallet link message");
  const value = (i: number, label: string) => {
    const line = lines[i] ?? "";
    if (!line.startsWith(`${label}: `)) throw new LinkError("not a wallet link message");
    return line.slice(label.length + 2);
  };
  if (value(1, "Account") !== expected.accountId)
    throw new LinkError("challenge for another wallet");
  if (value(2, "User") !== expected.userId) throw new LinkError("challenge for another person");
  if (value(3, "Nonce") !== bytesToHex(nonce)) throw new LinkError("challenge nonce mismatch");
  const issued = Date.parse(value(4, "Issued"));
  const expires = Date.parse(value(5, "Expires"));
  const now = expected.now.getTime();
  if (Number.isNaN(issued) || Number.isNaN(expires)) throw new LinkError("bad challenge times");
  if (expires - issued !== TTL_MS) throw new LinkError("challenge window isn't 5 minutes");
  if (issued > now + SKEW_MS || expires <= now) throw new LinkError("challenge isn't current");
  return nonce;
}

export async function linkWallet(input: {
  api: ApiClient;
  wallet: WalletSigner;
  userId: string;
  authRecipient: string;
  now: () => Date;
}): Promise<{ accountId: string }> {
  const account = await input.wallet.connect();
  const challenge = await input.api.call("POST /auth/wallet-link/challenge", {
    body: { accountId: account.accountId },
  });
  const nonce = checkLinkChallenge(challenge, {
    accountId: account.accountId,
    userId: input.userId,
    authRecipient: input.authRecipient,
    now: input.now(),
  });
  const signed = await input.wallet.signMessage({
    message: challenge.message,
    recipient: challenge.recipient,
    nonce,
  });
  if (signed.accountId !== account.accountId)
    throw new LinkError("the wallet signed as another account");
  return input.api.call("POST /auth/wallet-link", {
    body: {
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: signed.signature,
      nonce: challenge.nonce,
    },
  });
}
