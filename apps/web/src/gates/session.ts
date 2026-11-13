// Session gate (slice W6): before a wallet is asked to open a NEAR Intents session, the browser
// checks the request itself. A session is an EMPTY intent: no transfer, no swap, nothing that moves
// money. The API (possibly compromised, T-2) serves the bytes, so a request with anything else in it,
// for another account, for another verifier, already expired or open for too long, is refused and
// the wallet never sees it.
import { base64 } from "@scure/base";
import { z } from "zod";

/** The verifier contract whose intents these are (docs; the same one the payout gates pin). */
export const SESSION_VERIFIER = "intents.near";
/** A session request is asked for and signed within minutes; longer is not a request we made. */
export const SESSION_MAX_WINDOW_MS = 10 * 60 * 1000;

const body = z
  .object({
    deadline: z.iso.datetime({ offset: true }),
    intents: z.array(z.never()).length(0),
    signer_id: z.string().min(1).max(64),
  })
  .strict();

export type SessionCheck = { ok: true; nonce: Uint8Array } | { ok: false; reason: string };

export function checkSessionRequest(
  payload: { message: string; nonce: string; recipient: string },
  expected: { accountId: string; now: Date },
): SessionCheck {
  if (payload.recipient !== SESSION_VERIFIER) {
    return { ok: false, reason: "the request is for a different verifier than NEAR Intents" };
  }
  let parsed;
  try {
    parsed = body.safeParse(JSON.parse(payload.message));
  } catch {
    return { ok: false, reason: "the request isn't readable" };
  }
  if (!parsed.success) {
    return {
      ok: false,
      reason: "the request is not an empty intent, so your wallet was not asked",
    };
  }
  const { deadline, signer_id: signer } = parsed.data;
  // Exactly the bytes we expect, not a lookalike with extra spaces or reordered keys.
  if (payload.message !== JSON.stringify({ deadline, intents: [], signer_id: signer })) {
    return { ok: false, reason: "the request is not in the exact form Veylo expects" };
  }
  if (signer !== expected.accountId) {
    return { ok: false, reason: "the request is for a different account than your wallet" };
  }
  const ms = Date.parse(deadline) - expected.now.getTime();
  if (!(ms > 0)) return { ok: false, reason: "the request has already expired" };
  if (ms > SESSION_MAX_WINDOW_MS) return { ok: false, reason: "the request stays open too long" };
  let nonce: Uint8Array;
  try {
    nonce = base64.decode(payload.nonce);
  } catch {
    return { ok: false, reason: "the request's nonce isn't readable" };
  }
  if (nonce.length !== 32) return { ok: false, reason: "the request's nonce is the wrong length" };
  return { ok: true, nonce };
}
