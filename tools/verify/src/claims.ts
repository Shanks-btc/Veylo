// Claims stay factual (slice W5): nothing Veylo says about itself may be "the first", "the only"
// or "unique". The same check guards the README and the user-facing copy of the web app.
/** Phrases that claim to be first, only or unique. A plain "first payout" is not a claim. */
export const CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:the|world's|an?)\s+(?:very\s+)?(?:first|only)\s+(?:ever\s+)?(?:private|payroll|confidential|platform|tool|app|product|solution|way|service|system)\b/i,
  /\b(?:the|world's)\s+(?:first|only)\b/i,
  /\bfirst[- ](?:ever|of its kind|to)\b/i,
  /\bonly\s+(?:one|payroll|private|platform|tool|app|product|solution|way|service)\b/i,
  /\bone[- ]of[- ]a[- ]kind\b/i,
  /\bunique(?:ly)?\b/i,
];

/** Every line of `text` that makes such a claim (comment-only lines are skipped). */
export function findClaims(text: string): string[] {
  return text
    .split("\n")
    .map((line, i) => ({ line, at: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(({ line }) => CLAIM_PATTERNS.some((p) => p.test(line)))
    .map(({ line, at }) => `line ${at}: ${line.trim().slice(0, 100)}`);
}

/**
 * Things Veylo does not offer (slice W7.1): no yield, APY, interest, card, Visa, bank or off-ramp. The
 * words below must not appear in user-facing copy at all. (The problem section's "Bank wires take days"
 * describes the old way of paying abroad; it says nothing about what Veylo offers.)
 */
export const NOT_OFFERED_PATTERNS: readonly RegExp[] = [
  /\bAPY\b/i,
  /\byields?\b/i,
  /\binterest\b/i,
  /\bvisa\b/i,
  /\bdebit[- ]cards?\b/i,
  /\boff-?ramps?\b/i,
];

/** Every line of `text` that uses one of those words (comment-only lines are skipped). */
export function findNotOffered(text: string): string[] {
  return text
    .split("\n")
    .map((line, i) => ({ line, at: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(({ line }) => NOT_OFFERED_PATTERNS.some((p) => p.test(line)))
    .map(({ line, at }) => `line ${at}: ${line.trim().slice(0, 100)}`);
}
