// T7 on NEAR testnet: local JS facilitator, seller route at 0.01 testnet USDC, agent pays. Testnet only.
// Stops on any error, with no retries. Never prints or records a secret key. Run: npx tsx scripts/t7-run.ts
import type { Server } from "node:http";
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { createNearFacilitator } from "@fastnear/x402/facilitator";
import { createNearResourceServer } from "@fastnear/x402/server";
import { createLocalNearSigner } from "@fastnear/x402/node";
import { createNearPaymentFetch } from "@fastnear/x402";
import { record } from "../_util.js";

const RPC = "https://rpc.testnet.fastnear.com";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const PRICE_UNITS = "10000"; // 0.01 USDC, 6 decimals
const FACILITATOR_PORT = 4022;
const SELLER_PORT = 4021;
const FACILITATOR_URL = `http://127.0.0.1:${FACILITATOR_PORT}`;
const RESOURCE_URL = `http://127.0.0.1:${SELLER_PORT}/weather`;

const servers: Server[] = [];
function finish(code: number): never {
  for (const server of servers) server.close();
  process.exit(code);
}
function stop(reason: string): never {
  console.log(`STOPPED: ${reason}`);
  finish(1);
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) stop(`${name} is not set`);
  return value as string;
}

const AGENT = required("AGENT_TESTNET_ACCOUNT_ID");
const SELLER = required("SELLER_TESTNET_ACCOUNT_ID");
const RELAYER = required("FACILITATOR_RELAYER_TESTNET_ACCOUNT_ID");

async function view(params: Record<string, unknown>) {
  const body = { jsonrpc: "2.0", id: "veylo", method: "query", params: { finality: "final", ...params } };
  const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return (await res.json()) as { result?: { amount?: string; result?: number[] }; error?: unknown };
}
async function usdcBalance(id: string): Promise<string | undefined> {
  const out = await view({ request_type: "call_function", account_id: USDC, method_name: "ft_balance_of", args_base64: Buffer.from(JSON.stringify({ account_id: id })).toString("base64") });
  return out.result?.result ? (JSON.parse(Buffer.from(out.result.result).toString()) as string) : undefined;
}
const nearBalance = async (id: string) => (await view({ request_type: "view_account", account_id: id })).result?.amount;
async function snapshot() {
  return {
    at: new Date().toISOString(),
    agentNear: await nearBalance(AGENT),
    agentUsdc: await usdcBalance(AGENT),
    sellerNear: await nearBalance(SELLER),
    sellerUsdc: await usdcBalance(SELLER),
    relayerNear: await nearBalance(RELAYER),
  };
}
function decodeHeader(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString());
  } catch {
    return undefined;
  }
}
const listen = (app: express.Express, port: number) =>
  new Promise<void>((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
    servers.push(server);
  });

const before = await snapshot();
record("T7", "balances-before", before);
console.log(`Before: ${JSON.stringify(before)}`);
if (!before.agentUsdc || BigInt(before.agentUsdc) < BigInt(PRICE_UNITS)) stop(`agent USDC is ${before.agentUsdc}`);

// Facilitator, as in the package README's self-hosted example. It binds to loopback only.
const facilitator = createNearFacilitator({
  registrations: [{
    network: "near:testnet",
    signer: {
      relayers: [{ accountId: RELAYER, secretKey: required("FACILITATOR_RELAYER_TESTNET_SECRET_KEY") }],
      rpcUrls: { "near:testnet": RPC },
    },
  }],
} as Parameters<typeof createNearFacilitator>[0]);

const facilitatorCalls: Record<string, unknown>[] = [];
const facilitatorApp = express();
facilitatorApp.use(express.json());
facilitatorApp.post("/verify", async (request, response, next) => {
  try {
    const { paymentPayload, paymentRequirements } = request.body;
    const result = await facilitator.verify(paymentPayload, paymentRequirements);
    facilitatorCalls.push({ at: new Date().toISOString(), route: "/verify", paymentPayload, paymentRequirements, result });
    response.json(result);
  } catch (error) {
    facilitatorCalls.push({ at: new Date().toISOString(), route: "/verify", error: String(error) });
    next(error);
  }
});
facilitatorApp.post("/settle", async (request, response, next) => {
  try {
    const { paymentPayload, paymentRequirements } = request.body;
    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    facilitatorCalls.push({ at: new Date().toISOString(), route: "/settle", paymentPayload, paymentRequirements, result });
    response.json(result);
  } catch (error) {
    facilitatorCalls.push({ at: new Date().toISOString(), route: "/settle", error: String(error) });
    next(error);
  }
});
facilitatorApp.get("/supported", (_request, response) => {
  response.json(facilitator.getSupported());
});
await listen(facilitatorApp, FACILITATOR_PORT);

const supportedRes = await fetch(`${FACILITATOR_URL}/supported`);
const supported = await supportedRes.json();
record("T7", "testnet-supported", { ranAt: new Date().toISOString(), facilitator: FACILITATOR_URL, status: supportedRes.status, body: supported });
console.log(`Supported | HTTP ${supportedRes.status} | ${JSON.stringify(supported)}`);

// Seller, as in the README's resource-server example, with no facilitator authentication.
const resourceServer = createNearResourceServer({ facilitators: { url: FACILITATOR_URL } });
const sellerApp = express();
sellerApp.use(paymentMiddleware({
  "GET /weather": {
    accepts: [{ scheme: "exact", network: "near:testnet", price: "$0.01", payTo: SELLER }],
    description: "T7 testnet weather report",
    mimeType: "application/json",
  },
}, resourceServer));
sellerApp.get("/weather", (_request, response) => {
  response.json({ weather: "sunny", paid: true });
});
await listen(sellerApp, SELLER_PORT);

// The raw challenge: a plain request with no payment.
const challengeRes = await fetch(RESOURCE_URL);
const challengeText = await challengeRes.text();
let challengeBody: unknown = challengeText;
try {
  challengeBody = JSON.parse(challengeText);
} catch {
  // Non-JSON is kept verbatim as text.
}
const challengeHeaders = Object.fromEntries(challengeRes.headers);
const decodedChallenge = decodeHeader(challengeRes.headers.get("payment-required"));
record("T7", "testnet-402-challenge", { ranAt: new Date().toISOString(), request: { method: "GET", url: RESOURCE_URL }, response: { status: challengeRes.status, headers: challengeHeaders, body: challengeBody }, decodedPaymentRequiredHeader: decodedChallenge });
console.log(`Challenge | HTTP ${challengeRes.status} | headers ${Object.keys(challengeHeaders).join(", ")}`);
console.log(`  Body: ${challengeText.slice(0, 900)}`);
if (decodedChallenge) console.log(`  Decoded header: ${JSON.stringify(decodedChallenge).slice(0, 900)}`);
if (challengeRes.status !== 402) stop(`expected HTTP 402, got ${challengeRes.status}`);

// Check what is being charged before paying: the seller, the amount and the asset must all be as specified.
type Accept = { scheme?: string; network?: string; amount?: string; asset?: string; payTo?: string };
const source = (decodedChallenge ?? challengeBody) as { accepts?: Accept[] };
const accept = source?.accepts?.[0];
if (!accept) stop("the 402 challenge has no accepts entry where the x402 v2 format places it");
const offered = accept as Accept;
if (offered.amount !== PRICE_UNITS || offered.asset !== USDC || offered.payTo !== SELLER || offered.network !== "near:testnet" || offered.scheme !== "exact") {
  stop(`the challenge does not match the spec: ${JSON.stringify(offered)}`);
}

// Agent pays.
const signer = createLocalNearSigner({ accountId: AGENT, secretKey: required("AGENT_TESTNET_SECRET_KEY"), rpcUrls: { "near:testnet": RPC } } as Parameters<typeof createLocalNearSigner>[0]);
const paidFetch = createNearPaymentFetch({ signer, network: "near:testnet" });
const startedAt = Date.now();
const paid = await paidFetch(RESOURCE_URL);
const elapsedMs = Date.now() - startedAt;
const paidText = await paid.text();
let paidBody: unknown = paidText;
try {
  paidBody = JSON.parse(paidText);
} catch {
  // Non-JSON is kept verbatim as text.
}
const paidHeaders = Object.fromEntries(paid.headers);
const settlementHeader = paid.headers.get("payment-response") ?? paid.headers.get("x-payment-response");
const decodedSettlement = decodeHeader(settlementHeader) as { transaction?: string; success?: boolean; payer?: string; network?: string } | undefined;
record("T7", "testnet-paid-response", { ranAt: new Date().toISOString(), elapsedMs, response: { status: paid.status, headers: paidHeaders, body: paidBody }, decodedSettlementHeader: decodedSettlement });
record("T7", "testnet-facilitator-calls", { calls: facilitatorCalls });
console.log(`Paid | HTTP ${paid.status} | ${elapsedMs} ms | headers ${Object.keys(paidHeaders).join(", ")}`);
console.log(`  Body: ${paidText.slice(0, 500)}`);
console.log(`  Decoded settlement: ${JSON.stringify(decodedSettlement)}`);
console.log(`  Facilitator calls: ${facilitatorCalls.map((c) => c.route).join(", ")}`);
for (const call of facilitatorCalls) if (call.result || call.error) console.log(`  ${String(call.route)}: ${JSON.stringify(call.result ?? call.error).slice(0, 400)}`);

// Balances right away, then again after settlement has had time to finalise.
const after = await snapshot();
await new Promise((resolve) => setTimeout(resolve, 15_000));
const settled = await snapshot();

const txHash = decodedSettlement?.transaction;
let txOutcome: unknown;
if (txHash) {
  const body = { jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: txHash, sender_account_id: RELAYER, wait_until: "FINAL" } };
  const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  txOutcome = await res.json();
}
const outcome = txOutcome as { result?: { status?: unknown; transaction?: { signer_id?: string; receiver_id?: string }; receipts_outcome?: { outcome: { logs: string[]; status: unknown; executor_id: string } }[] } } | undefined;
const logs = (outcome?.result?.receipts_outcome ?? []).flatMap((r) => r.outcome.logs);
record("T7", "testnet-settlement", { txHash, explorer: txHash ? `https://testnet.nearblocks.io/txns/${txHash}` : undefined, signer: outcome?.result?.transaction?.signer_id, receiver: outcome?.result?.transaction?.receiver_id, status: outcome?.result?.status, logs, raw: txOutcome });
record("T7", "balances-after", { after, settled });
console.log(`Settlement tx ${txHash}; signer ${outcome?.result?.transaction?.signer_id}; receiver ${outcome?.result?.transaction?.receiver_id}; status ${JSON.stringify(outcome?.result?.status)}`);
for (const log of logs) console.log(`  log: ${log.slice(0, 300)}`);
console.log(`After: ${JSON.stringify(after)}`);
console.log(`After 15s: ${JSON.stringify(settled)}`);
finish(0);
