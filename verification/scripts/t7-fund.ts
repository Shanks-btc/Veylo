// T7 setup, testnet only: the funder pays the three accounts and registers agent and seller on testnet USDC.
// Run: npx tsx scripts/t7-fund.ts. Never prints or records a secret key.
import { Account, JsonRpcProvider, nearToYocto, teraToGas } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { record } from "../_util.js";

const RPC = "https://rpc.testnet.fastnear.com";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n; // Read from storage_balance_bounds on the contract

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.log(`STOPPED: ${name} is not set`);
    process.exit(1);
  }
  return value;
}
const funderId = required("FUNDER_TESTNET_ACCOUNT_ID");
const agent = required("AGENT_TESTNET_ACCOUNT_ID");
const seller = required("SELLER_TESTNET_ACCOUNT_ID");
const relayer = required("FACILITATOR_RELAYER_TESTNET_ACCOUNT_ID");

const provider = new JsonRpcProvider({ url: RPC });
const funder = new Account(funderId, provider, required("FUNDER_TESTNET_SECRET_KEY") as KeyPairString);

async function view(params: Record<string, unknown>) {
  const body = { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", ...params } };
  const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return (await res.json()) as { result?: { amount?: string; result?: number[] }; error?: unknown };
}
const nearBalance = async (id: string) => (await view({ request_type: "view_account", account_id: id })).result?.amount;
async function usdc(method: string, args: unknown) {
  const out = await view({ request_type: "call_function", account_id: USDC, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return out.result?.result ? JSON.parse(Buffer.from(out.result.result).toString()) : undefined;
}
const hash = (outcome: unknown) => (outcome as { transaction?: { hash?: string } })?.transaction?.hash;

const steps: Record<string, unknown>[] = [];
const plan = [
  { id: relayer, role: "relayer", near: "5" },
  { id: agent, role: "agent", near: "0.1" },
  { id: seller, role: "seller", near: "0.1" },
];
for (const p of plan) {
  const outcome = await funder.transfer({ receiverId: p.id, amount: nearToYocto(p.near as `${number}`) });
  steps.push({ step: "transfer", role: p.role, account: p.id, near: p.near, tx: hash(outcome) });
  console.log(`transfer ${p.near} NEAR to ${p.role}: ${hash(outcome)}`);
}
for (const [role, id] of [["agent", agent], ["seller", seller]] as const) {
  const outcome = await funder.callFunctionRaw({ contractId: USDC, methodName: "storage_deposit", args: { account_id: id, registration_only: true }, gas: teraToGas("30"), deposit: STORAGE_DEPOSIT });
  steps.push({ step: "storage_deposit", role, account: id, tx: hash(outcome) });
  console.log(`storage_deposit for ${role}: ${hash(outcome)}`);
}

const state = {
  funderNear: await nearBalance(funderId),
  relayerNear: await nearBalance(relayer),
  agentNear: await nearBalance(agent),
  sellerNear: await nearBalance(seller),
  agentUsdcStorage: await usdc("storage_balance_of", { account_id: agent }),
  sellerUsdcStorage: await usdc("storage_balance_of", { account_id: seller }),
  agentUsdc: await usdc("ft_balance_of", { account_id: agent }),
  sellerUsdc: await usdc("ft_balance_of", { account_id: seller }),
  usdcMetadata: await usdc("ft_metadata", {}),
};
console.log(record("T7", "testnet-setup", { ranAt: new Date().toISOString(), rpc: RPC, usdcContract: USDC, steps, state }));
console.log(JSON.stringify({ ...state, usdcMetadata: { ...(state.usdcMetadata as object), icon: undefined } }, null, 1));
