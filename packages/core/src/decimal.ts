// Exact decimal text to a scaled integer (slice W6). A price or a rate arrives as text such as
// "3.43" or "1349.822603". It is read digit by digit into a bigint with 12 decimal places: no float
// is ever involved, so there is nothing to round by accident. Display code (local-currency
// estimates) and payout code (sizing a NEAR request from a reference price) both need exactly this,
// and neither depends on the other: this file knows about neither.

const DECIMAL = /^\d{1,12}(\.\d{1,12})?$/;
/** Decimal places of the integers this file returns. */
export const DECIMAL_SCALE = 12;

/** "1349.822603" as a bigint with 12 decimal places, or undefined if malformed or not positive. */
export function parseDecimal12(text: string): bigint | undefined {
  if (!DECIMAL.test(text)) return undefined;
  const [whole = "0", frac = ""] = text.split(".");
  const digits = `${whole}${frac.padEnd(DECIMAL_SCALE, "0")}`;
  let n = 0n;
  for (const ch of digits) n = n * 10n + BigInt(ch.charCodeAt(0) - 48);
  return n > 0n ? n : undefined;
}
