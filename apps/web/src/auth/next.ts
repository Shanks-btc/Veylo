// Where to go after signing in (slice W6). A contractor opens an invite link, has no account yet, and
// is sent to sign up or sign in. The invite page asks to come back with ?next=. Only the portal's own
// pages are allowed, with at most an invite code, so this can never become an open redirect.
const ALLOWED = /^\/portal(\/(accept|address|balance))?(\?token=[A-Za-z0-9_-]{43})?$/;

export function safeNext(search: string): string | undefined {
  const next = new URLSearchParams(search).get("next");
  return next !== null && ALLOWED.test(next) ? next : undefined;
}

/** A link to another sign-in page that keeps the way back. */
export function withNext(path: string, search: string): string {
  const next = safeNext(search);
  return next === undefined ? path : `${path}?next=${encodeURIComponent(next)}`;
}
