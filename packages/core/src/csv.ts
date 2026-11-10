/** Exact decimal text from smallest units: always `decimals` places, never a float. */
export function formatFixed(units: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new RangeError("decimals must be a whole number from 0 to 30");
  }
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = (abs / scale).toString();
  const fraction = (abs % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}${decimals > 0 ? `.${fraction}` : ""}`;
}

/** Cells a spreadsheet would run as a formula (CSV injection, OWASP). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell: neutralized against formulas, then quoted as RFC 4180 requires. */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? "";
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180: CRLF line endings, a header row, every row the same width. */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): string {
  for (const row of rows) {
    if (row.length !== headers.length) throw new RangeError("every row must match the header");
  }
  return [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
