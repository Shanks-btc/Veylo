// T5 step A: read the treasury's NEAR and USDC balances through public RPC. Read-only.
// Run: npx tsx scripts/t5-funding.ts [label]
import { record } from "../_util.js";

const RPC = "https://rpc.fastnear.com";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const treasury = process.env.TREASURY_ACCOUNT_ID?.trim();
if (!treasury) {
  console.log("Stopped: TREASURY_ACCOUNT_ID is not set.");
  process.exit(1);
}

async function rpc(params: Record<string, unknown>) {
  const body = { jsonrpc: "2.0", id: "veylo", method: "query", params };
  const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const parsed = (await res.json()) as { result?: { amount?: string; result?: number[] }; error?: unknown };
  return { request: { url: RPC, body }, status: res.status, response: parsed };
}

const account = await rpc({ request_type: "view_account", finality: "final", account_id: treasury });
const usdc = await rpc({
  request_type: "call_function",
  finality: "final",
  account_id: USDC,
  method_name: "ft_balance_of",
  args_base64: Buffer.from(JSON.stringify({ account_id: treasury })).toString("base64"),
});

const near = account.response.result?.amount;
const usdcBytes = usdc.response.result?.result;
const usdcRaw: string | undefined = usdcBytes ? JSON.parse(Buffer.from(usdcBytes).toString()) : undefined;
const label = process.argv[2] ?? "funding";

console.log(record("T5", label, { ranAt: new Date().toISOString(), treasury, account, usdc, parsed: { nearYocto: near, usdcSmallestUnit: usdcRaw } }));
console.log(`NEAR (yocto): ${near ?? "unavailable"}`);
console.log(`USDC (smallest unit): ${usdcRaw ?? "unavailable"}`);
if (!near) console.log(`view_account response: ${JSON.stringify(account.response.error ?? account.response.result)}`);
if (usdcRaw === undefined) console.log(`ft_balance_of response: ${JSON.stringify(usdc.response.error ?? usdc.response.result)}`);
