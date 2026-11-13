// Local-currency display (slice W6, part 3c). Estimates beside a USD amount, nothing more.
//
// RULE: a display estimate is never an input to money. Salaries are set in USD, payouts are quoted
// and signed in the asset units the gates check, and nothing in packages/core, the settlement
// worker, the quote code or a signature path may import this file (a test reads their sources).
// Rates are decimal strings and the arithmetic is bigint, like everywhere else money is touched.

import { parseDecimal12 } from "./decimal.js";

export type DisplayCurrency = {
  readonly code: string;
  readonly name: string;
  readonly symbol: string;
  /** Digits after the decimal point when shown. */
  readonly decimals: number;
};

/** The currencies a contractor or organisation can pick. USD is the real amount, not an estimate. */
export const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = [
  { code: "USD", name: "US dollar", symbol: "$", decimals: 2 },
  { code: "NGN", name: "Nigerian naira", symbol: "₦", decimals: 2 },
  { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
  { code: "GBP", name: "British pound", symbol: "£", decimals: 2 },
  { code: "KES", name: "Kenyan shilling", symbol: "KSh", decimals: 2 },
  { code: "INR", name: "Indian rupee", symbol: "₹", decimals: 2 },
  { code: "GHS", name: "Ghanaian cedi", symbol: "GH₵", decimals: 2 },
  { code: "ZAR", name: "South African rand", symbol: "R", decimals: 2 },
  { code: "UGX", name: "Ugandan shilling", symbol: "USh", decimals: 0 },
  { code: "TZS", name: "Tanzanian shilling", symbol: "TSh", decimals: 2 },
  { code: "EGP", name: "Egyptian pound", symbol: "E£", decimals: 2 },
  { code: "MAD", name: "Moroccan dirham", symbol: "MAD", decimals: 2 },
  { code: "BRL", name: "Brazilian real", symbol: "R$", decimals: 2 },
  { code: "MXN", name: "Mexican peso", symbol: "MX$", decimals: 2 },
  { code: "ARS", name: "Argentine peso", symbol: "AR$", decimals: 2 },
  { code: "COP", name: "Colombian peso", symbol: "COL$", decimals: 0 },
  { code: "CLP", name: "Chilean peso", symbol: "CLP$", decimals: 0 },
  { code: "PEN", name: "Peruvian sol", symbol: "S/", decimals: 2 },
  { code: "PHP", name: "Philippine peso", symbol: "₱", decimals: 2 },
  { code: "IDR", name: "Indonesian rupiah", symbol: "Rp", decimals: 0 },
  { code: "VND", name: "Vietnamese dong", symbol: "₫", decimals: 0 },
  { code: "PKR", name: "Pakistani rupee", symbol: "Rs", decimals: 2 },
  { code: "BDT", name: "Bangladeshi taka", symbol: "৳", decimals: 2 },
  { code: "LKR", name: "Sri Lankan rupee", symbol: "Rs", decimals: 2 },
  { code: "TRY", name: "Turkish lira", symbol: "₺", decimals: 2 },
  { code: "PLN", name: "Polish zloty", symbol: "zł", decimals: 2 },
  { code: "UAH", name: "Ukrainian hryvnia", symbol: "₴", decimals: 2 },
  { code: "CAD", name: "Canadian dollar", symbol: "C$", decimals: 2 },
  { code: "AUD", name: "Australian dollar", symbol: "A$", decimals: 2 },
  { code: "JPY", name: "Japanese yen", symbol: "¥", decimals: 0 },
];

export const DISPLAY_CURRENCY_CODES: readonly string[] = DISPLAY_CURRENCIES.map((c) => c.code);

export function displayCurrency(code: string): DisplayCurrency | undefined {
  return DISPLAY_CURRENCIES.find((c) => c.code === code);
}

/** A rate such as "1349.822603" as bigint with 12 decimal places, or undefined if malformed. */
export const parseRate = parseDecimal12;

/**
 * USD in 6-decimal units (USDC) times a rate, rounded half up to the currency's own decimals,
 * returned as minor units of that currency (cents for 2 decimals, whole units for 0).
 */
export function convertUsdUnits(usdUnits: bigint, rate: bigint, currency: DisplayCurrency): bigint {
  // usdUnits has 6 decimals, rate has 12: the product has 18. Keep `currency.decimals` of them.
  const drop = 10n ** BigInt(18 - currency.decimals);
  const product = usdUnits * rate;
  return (product + drop / 2n) / drop;
}

/** "₦1,349,822.60", from minor units. Grouping is plain ASCII commas: no locale, no floats. */
export function formatLocal(minor: bigint, currency: DisplayCurrency): string {
  const base = 10n ** BigInt(currency.decimals);
  const whole = (minor / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac =
    currency.decimals === 0 ? "" : `.${(minor % base).toString().padStart(currency.decimals, "0")}`;
  return `${currency.symbol}${whole}${frac}`;
}

/** What the screens show beside a USD amount, or undefined when there is no usable rate. */
export function estimateText(
  usdUnits: bigint,
  rateText: string | undefined,
  code: string,
): string | undefined {
  const currency = displayCurrency(code);
  if (!currency || code === "USD" || rateText === undefined) return undefined;
  const rate = parseRate(rateText);
  if (rate === undefined) return undefined;
  return `≈ ${formatLocal(convertUsdUnits(usdUnits, rate, currency), currency)}`;
}
