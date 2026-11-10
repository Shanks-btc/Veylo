// Reads the funding transaction's block time from public BSC RPC. Read-only.
// The sender's address is held in memory only, to confirm it is in no results file. It is never printed or saved,
// which is why this evidence stores selected fields and not the raw RPC responses.
// Run: npx tsx scripts/t5-fund-origin.ts
import { readdirSync, readFileSync } from "node:fs";
import { record } from "../_util.js";

const RPC = "https://bsc-dataseed.binance.org";
const results = new URL("../results/", import.meta.url);
const status = JSON.parse(readFileSync(new URL("T5-fund-status.json", results), "utf8"));
const last = status.transitions.at(-1).response.body;
const hash: string = last.swapDetails.originChainTxHashes[0].hash;

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  return ((await res.json()) as { result: Record<string, string> }).result;
}

const tx = await rpc("eth_getTransactionByHash", [hash]);
const receipt = await rpc("eth_getTransactionReceipt", [hash]);
const block = await rpc("eth_getBlockByNumber", [tx.blockNumber, false]);

const sentAt = new Date(Number(BigInt(block.timestamp)) * 1000);
const successSeen = status.transitions.find((t: { status: string }) => t.status === "SUCCESS").at as string;
const processingSeen = status.transitions.find((t: { status: string }) => t.status === "PROCESSING").at as string;
const seconds = (iso: string) => (Date.parse(iso) - sentAt.getTime()) / 1000;

const sender = tx.from.toLowerCase();
const filesWithSender = readdirSync(results).filter((f) => readFileSync(new URL(f, results), "utf8").toLowerCase().includes(sender));

const summary = {
  originTxHash: hash,
  blockNumber: BigInt(tx.blockNumber).toString(),
  receiptStatus: receipt.status,
  blockTimestampUtc: sentAt.toISOString(),
  apiUpdatedAt: last.updatedAt,
  secondsSendToProcessingSeen: seconds(processingSeen),
  secondsSendToSuccessSeen: seconds(successSeen),
  secondsSendToApiUpdatedAt: seconds(last.updatedAt),
};
console.log(record("T5", "fund-origin-tx", { source: RPC, ...summary }));
console.log(JSON.stringify(summary, null, 1));
console.log(`Results files containing the sender's address: ${filesWithSender.length}`);
