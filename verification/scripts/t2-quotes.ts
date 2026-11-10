// T2: dry EXACT_OUTPUT payout quotes. dry:true always; this script cannot move funds.
// The fee table (minAmountIn basis, amountIn beside it) is not built yet: no run has returned a quote to derive fields from.
import { readFileSync } from "node:fs";
import { record } from "../_util.js";

const QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";
const ORIGIN_ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const PAIR_ERROR = "Quoting for this pair is not available";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.log(`T2 stopped: ${name} is not set.`);
    process.exit(1);
  }
  return value;
}

const JWT = required("ONECLICK_JWT");
const REFUND_TO = required("TREASURY_ACCOUNT_ID");
const ROUTES = [
  { route: "USDC near -> USDC sol", symbol: "USDC", chain: "sol", recipient: required("CONTRACTOR_SOLANA_ADDRESS") },
  { route: "USDC near -> USDC base", symbol: "USDC", chain: "base", recipient: required("CONTRACTOR_EVM_ADDRESS") },
  { route: "USDC near -> USDC arb", symbol: "USDC", chain: "arb", recipient: required("CONTRACTOR_EVM_ADDRESS") },
  { route: "USDC near -> USDT tron", symbol: "USDT", chain: "tron", recipient: required("CONTRACTOR_TRON_ADDRESS") },
];

type Token = { assetId: string; blockchain: string; symbol: string; decimals: number };
const t1 = JSON.parse(readFileSync(new URL("../results/T1-tokens.json", import.meta.url), "utf8"));
const tokens: Token[] = t1.response.body;

function asset(symbol: string, chain: string): Token {
  const hits = tokens.filter((t) => t.symbol === symbol && t.blockchain === chain);
  if (hits.length !== 1) throw new Error(`Expected one ${symbol} on ${chain}, got ${hits.length}`);
  return hits[0];
}

async function post(body: Record<string, unknown>, authenticated: boolean) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authenticated) headers["X-API-Key"] = JWT;
  const started = Date.now();
  const res = await fetch(QUOTE_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON is kept verbatim as text.
  }
  return {
    authenticated,
    latencyMs: Date.now() - started,
    request: { method: "POST", url: QUOTE_URL, headers, body },
    response: { status: res.status, headers: Object.fromEntries(res.headers), body: parsed },
  };
}

function quoteBody(r: (typeof ROUTES)[number]) {
  const destination = asset(r.symbol, r.chain);
  return {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: ORIGIN_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: destination.assetId,
    amount: (10n * 10n ** BigInt(destination.decimals)).toString(),
    recipient: r.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: REFUND_TO,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
}

const runs = [];
for (const r of ROUTES) {
  const body = quoteBody(r);
  const main = await post(body, true);
  runs.push({ route: r.route, kind: "EXACT_OUTPUT, authenticated", ...main });
  const message = (main.response.body as { message?: string } | null)?.message;
  if (message === PAIR_ERROR) {
    // Diagnostic: the same body except swapType, once, only after this exact error.
    const retry = await post({ ...body, swapType: "EXACT_INPUT" }, true);
    runs.push({ route: r.route, kind: "EXACT_INPUT diagnostic, authenticated", ...retry });
  }
}
const comparison = await post(quoteBody(ROUTES[0]), false);
runs.push({ route: ROUTES[0].route, kind: "EXACT_OUTPUT, unauthenticated comparison", ...comparison });

console.log(record("T2", "quotes", { ranAt: new Date().toISOString(), runs }));
for (const run of runs) console.log(`${run.route} | ${run.kind} | HTTP ${run.response.status} | ${run.latencyMs}ms`);
