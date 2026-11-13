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
