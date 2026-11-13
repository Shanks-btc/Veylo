// Sign in with NEAR (L23): POST /auth/challenge, sign it (NEP-413) in the wallet, POST /auth/verify.
// The session is the API's httpOnly cookie; nothing goes in localStorage.
//
// The challenge comes from the API, which T-2 treats as possibly compromised, so it's checked
// before the wallet ever sees it: exactly the sign-in format, for this account and this app, with
// a fresh 5-minute window. A served "challenge" that is really a payee approval or a payout can't
// reach the wallet this way.
import { base64 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ApiClient } from "../api/client.js";
import type { WalletSigner } from "../wallet/types.js";

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const SKEW_MS = 2 * 60_000;

/** Throws unless the challenge is exactly what the API's sign-in route produces. */
export function checkChallenge(
  challenge: { message: string; nonce: string; recipient: string },
  expected: { accountId: string; authRecipient: string; now: Date },
): Uint8Array {
  if (challenge.recipient !== expected.authRecipient)
    throw new SignInError("challenge for another app");
  let nonce: Uint8Array;
  try {
    nonce = base64.decode(challenge.nonce);
  } catch {
    throw new SignInError("bad challenge nonce");
  }
  if (nonce.length !== 32) throw new SignInError("bad challenge nonce");
  const lines = challenge.message.split("\n");
  const value = (i: number, label: string) => {
    const line = lines[i] ?? "";
    if (!line.startsWith(`${label}: `)) throw new SignInError("not a sign-in challenge");
    return line.slice(label.length + 2);
  };
  if (lines.length !== 5 || lines[0] !== "Sign in to Veylo")
    throw new SignInError("not a sign-in challenge");
  if (value(1, "Account") !== expected.accountId)
    throw new SignInError("challenge for another account");
  if (value(2, "Nonce") !== bytesToHex(nonce)) throw new SignInError("challenge nonce mismatch");
  const issued = Date.parse(value(3, "Issued"));
  const expires = Date.parse(value(4, "Expires"));
  const now = expected.now.getTime();
  if (Number.isNaN(issued) || Number.isNaN(expires)) throw new SignInError("bad challenge times");
  if (expires - issued !== CHALLENGE_TTL_MS)
    throw new SignInError("challenge window isn't 5 minutes");
  if (issued > now + SKEW_MS || expires <= now) throw new SignInError("challenge isn't current");
  return nonce;
}

export async function signIn(input: {
  api: ApiClient;
  wallet: WalletSigner;
  authRecipient: string;
  now: () => Date;
}): Promise<{ accountId: string }> {
  const account = await input.wallet.connect();
  const challenge = await input.api.call("POST /auth/challenge", {
    body: { accountId: account.accountId },
  });
  const nonce = checkChallenge(challenge, {
    accountId: account.accountId,
    authRecipient: input.authRecipient,
    now: input.now(),
  });
  const signed = await input.wallet.signMessage({
    message: challenge.message,
    recipient: challenge.recipient,
    nonce,
  });
  if (signed.accountId !== account.accountId)
    throw new SignInError("the wallet signed as another account");
  return input.api.call("POST /auth/verify", {
    body: {
      accountId: signed.accountId,
      publicKey: signed.publicKey,
      signature: signed.signature,
      nonce: challenge.nonce,
    },
  });
}

export async function signOut(input: { api: ApiClient; wallet?: WalletSigner }): Promise<void> {
  await input.api.call("POST /auth/logout");
  await input.wallet?.disconnect().catch(() => undefined);
}
