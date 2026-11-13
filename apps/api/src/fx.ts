// Display-only FX rates (slice W6, part 3c). One documented free public source, fetched by the API,
// cached for at most an hour, and "unavailable" on any failure: never a stale or invented rate.
//
// Source: ExchangeRate-API open access, https://open.er-api.com/v6/latest/USD (docs:
// https://www.exchangerate-api.com/docs/free; terms: https://www.exchangerate-api.com/terms), read
// 2026-11-12. It updates once a day, needs no key, and asks for an attribution link, which the
// screens show with every estimate.
//
// Nothing here is ever an input to a payout, a quote, a fee, a ledger row or a signature. Rates stay
// text: they are read from the response body without being turned into floating point.
import { DISPLAY_CURRENCY_CODES, parseRate } from "@veylo/core";

export const FX_URL = "https://open.er-api.com/v6/latest/USD";
export const FX_SOURCE = {
  name: "ExchangeRate-API",
  url: "https://www.exchangerate-api.com",
  termsUrl: "https://www.exchangerate-api.com/terms",
  attribution: "Rates by Exchange Rate API",
} as const;
export const FX_CACHE_MS = 60 * 60 * 1000;

export type FxRates =
  | {
      available: true;
      base: "USD";
      rates: Record<string, string>;
      source: typeof FX_SOURCE;
      fetchedAt: string;
      providerUpdatedAt: string | null;
    }
  | { available: false };

export type FxClient = { rates(): Promise<FxRates> };

/** The decimal literal for `code` inside the "rates" object, exactly as the provider wrote it. */
export function rateLiteral(ratesObject: string, code: string): string | undefined {
  const m = new RegExp(`"${code}"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`).exec(ratesObject);
  return m?.[1];
}

export function parseFxBody(body: string, fetchedAt: Date): FxRates {
  if (!/"result"\s*:\s*"success"/.test(body) || !/"base_code"\s*:\s*"USD"/.test(body))
    return { available: false };
  const start = body.indexOf('"rates"');
  const open = start < 0 ? -1 : body.indexOf("{", start);
  const close = open < 0 ? -1 : body.indexOf("}", open);
  if (open < 0 || close < 0) return { available: false };
  const ratesObject = body.slice(open, close + 1);
  const rates: Record<string, string> = {};
  for (const code of DISPLAY_CURRENCY_CODES) {
    const literal = rateLiteral(ratesObject, code);
    if (literal !== undefined && parseRate(literal) !== undefined) rates[code] = literal;
  }
  if (rates.USD === undefined || Object.keys(rates).length < 5) return { available: false };
  const updated = /"time_last_update_utc"\s*:\s*"([^"]+)"/.exec(body)?.[1];
  const updatedMs = updated ? Date.parse(updated) : Number.NaN;
  return {
    available: true,
    base: "USD",
    rates,
    source: FX_SOURCE,
    fetchedAt: fetchedAt.toISOString(),
    providerUpdatedAt: Number.isNaN(updatedMs) ? null : new Date(updatedMs).toISOString(),
  };
}

export function createFxClient(options: {
  fetch: typeof fetch;
  clock: () => Date;
  ttlMs?: number;
}): FxClient {
  const ttl = options.ttlMs ?? FX_CACHE_MS;
  let cached: { at: number; value: FxRates } | undefined;
  return {
    async rates() {
      const now = options.clock();
      if (cached && now.getTime() - cached.at < ttl) return cached.value;
      try {
        const res = await options.fetch(FX_URL, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return { available: false };
        const value = parseFxBody(await res.text(), now);
        // Only a good answer is kept; after the hour a failure means "unavailable", not an old rate.
        if (value.available) cached = { at: now.getTime(), value };
        else cached = undefined;
        return value;
      } catch {
        cached = undefined;
        return { available: false };
      }
    },
  };
}
