// Privacy evidence: what can be fetched about the public C2 payout and the confidential payout. Read-only.
// Requests carry no credentials unless labelled "withPartnerJwt". Run: npx tsx scripts/t5b-privacy.ts
import { readFileSync } from "node:fs";
import { record } from "../_util.js";

const JWT = process.env.ONECLICK_JWT?.trim();
const TREASURY = process.env.TREASURY_ACCOUNT_ID?.trim();
const RECIPIENT = process.env.CONTRACTOR_EVM_ADDRESS?.trim();
if (!JWT || !TREASURY || !RECIPIENT) {
  console.log("Stopped: ONECLICK_JWT, TREASURY_ACCOUNT_ID or CONTRACTOR_EVM_ADDRESS is not set.");
  process.exit(1);
}
const results = new URL("../results/", import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, results), "utf8"));

const payouts = [
  { label: "public-c2", depositAddress: load("T5-c2-quote").response.body.quote.depositAddress as string, statusFile: "T5-c2-status" },
  { label: "confidential", depositAddress: load("T5b-payout-quote").response.body.quote.depositAddress as string, statusFile: "T5b-payout-status" },
];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url: string, headers: Record<string, string> = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON is kept verbatim as text.
    }
    return { at: new Date().toISOString(), request: { url, headers }, status: res.status, body };
  } catch (err) {
    return { at: new Date().toISOString(), request: { url, headers }, error: err instanceof Error ? err.message : String(err) };
  }
}
async function rpc(url: string, method: string, params: unknown) {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    return { request: { url, body }, status: res.status, response: (await res.json()) as { result?: Record<string, unknown>; error?: unknown } };
  } catch (err) {
    return { request: { url, body }, error: err instanceof Error ? err.message : String(err) };
  }
}
const visibleText = (html: unknown) => (typeof html === "string" ? html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
function nearDetail(hash: string, result: unknown) {
  const r = result as { transaction?: { signer_id?: string; receiver_id?: string }; receipts_outcome?: { outcome: { logs: string[] } }[] } | undefined;
  const logs = (r?.receipts_outcome ?? []).flatMap((o) => o.outcome.logs);
  return {
    hash,
    signer: r?.transaction?.signer_id,
    receiver: r?.transaction?.receiver_id,
    logCount: logs.length,
    mentionsTreasury: mentions(r, TREASURY as string),
    mentionsRecipient: mentions(r, RECIPIENT as string),
    logsMentioningTreasury: logs.filter((l) => mentions(l, TREASURY as string)),
    logsMentioningRecipient: logs.filter((l) => mentions(l, RECIPIENT as string)),
    logs,
  };
}
const mentions = (value: unknown, needle: string) => JSON.stringify(value ?? null).toLowerCase().includes(needle.toLowerCase());

const treasuryHex = TREASURY.toLowerCase();
const TRANSFER_TOPIC = "0xddf252ad"; // First bytes of keccak256("Transfer(address,address,uint256)")
const out: Record<string, unknown> = {};

for (const p of payouts) {
  const statusEvidence = load(p.statusFile);
  const details = statusEvidence.transitions.at(-1).response.body.swapDetails;
  const baseHash: string = details.destinationChainTxHashes.find((h: { hash: string }) => h.hash.startsWith("0x")).hash;
  const nearHashes: string[] = details.nearTxHashes;

  // (b) status with no partner key.
  const status = await get(`https://1click.chaindefuser.com/v0/status?depositAddress=${encodeURIComponent(p.depositAddress)}`);

  // (c) the explorer's public page, its API with no credentials, and its API with our JWT.
  const page = await get(`https://explorer.near-intents.org/transactions/${p.depositAddress}`);
  const apiUrl = `https://explorer.near-intents.org/api/v0/transactions?search=${encodeURIComponent(p.depositAddress)}&numberOfTransactions=5`;
  const apiAnonymous = await get(apiUrl);
  await sleep(6_000);
  const apiWithJwt = await get(apiUrl, { Authorization: `Bearer ${JWT}` });
  await sleep(6_000);

  // (d) the Base transaction.
  const tx = await rpc("https://mainnet.base.org", "eth_getTransactionByHash", [baseHash]);
  const receipt = await rpc("https://mainnet.base.org", "eth_getTransactionReceipt", [baseHash]);
  const txResult = (tx.response?.result ?? {}) as { from?: string; to?: string; input?: string };
  const logs = ((receipt.response?.result as { logs?: { address: string; topics: string[]; data: string }[] } | undefined)?.logs ?? []);
  const transfers = logs
    .filter((l) => l.topics[0]?.startsWith(TRANSFER_TOPIC))
    .map((l) => ({ token: l.address, from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), amount: BigInt(l.data).toString() }));
  const usdcSender = transfers.find((t) => t.to.toLowerCase() === RECIPIENT.toLowerCase())?.from;
  const senderCode = usdcSender ? await rpc("https://mainnet.base.org", "eth_getCode", [usdcSender, "latest"]) : undefined;
  const txFromCount = txResult.from ? await rpc("https://mainnet.base.org", "eth_getTransactionCount", [txResult.from, "latest"]) : undefined;

  // The public NEAR transactions that 1Click lists for the payout: does the treasury appear in them?
  const nearTxs = [];
  for (const hash of nearHashes) {
    const nearblocks = await get(`https://api.nearblocks.io/v1/txns/${hash}/full`);
    const fastnear = await rpc("https://rpc.fastnear.com", "tx", { tx_hash: hash, sender_account_id: "intents.near", wait_until: "NONE" });
    nearTxs.push({ hash, nearblocks, fastnear, nearblocksMentionsTreasury: mentions((nearblocks as { body?: unknown }).body, treasuryHex), fastnearMentionsTreasury: mentions(fastnear.response?.result, treasuryHex) });
    await sleep(1_500);
  }

  const summary = {
    depositAddress: p.depositAddress,
    baseHash,
    status: { http: status.status, mentionsTreasury: mentions(status.body, treasuryHex), mentionsRecipient: mentions(status.body, RECIPIENT), message: (status.body as { message?: string })?.message },
    explorerPage: { visibleText: visibleText(page.body).slice(0, 1800), http: page.status, bytes: typeof page.body === "string" ? page.body.length : undefined, mentionsDepositAddress: mentions(page.body, p.depositAddress), mentionsTreasury: mentions(page.body, treasuryHex), mentionsRecipient: mentions(page.body, RECIPIENT) },
    explorerApiAnonymous: { http: apiAnonymous.status, body: typeof apiAnonymous.body === "string" ? apiAnonymous.body.slice(0, 200) : apiAnonymous.body },
    explorerApiWithJwt: { http: apiWithJwt.status, mentionsTreasury: mentions(apiWithJwt.body, treasuryHex), mentionsRecipient: mentions(apiWithJwt.body, RECIPIENT), body: apiWithJwt.body },
    base: { txFrom: txResult.from, txTo: txResult.to, inputMentionsTreasury: mentions(txResult.input, treasuryHex), logsMentionTreasury: mentions(logs, treasuryHex), transfers, usdcSender, usdcSenderIsContract: senderCode ? senderCode.response?.result !== ("0x" as unknown) : undefined, txFromNonce: txFromCount?.response?.result },
    nearTxs: nearTxs.map((n) => ({ nearblocksHttp: (n.nearblocks as { status?: number }).status, nearblocksMentionsTreasury: n.nearblocksMentionsTreasury, ...nearDetail(n.hash, n.fastnear.response?.result) })),
  };
  record("T5b", `privacy-${p.label}`, { collectedAt: new Date().toISOString(), summary, raw: { status, page: { ...page, body: typeof page.body === "string" ? page.body.slice(0, 20_000) : page.body }, apiAnonymous, apiWithJwt, tx, receipt, senderCode, txFromCount, nearTxs } });
  out[p.label] = summary;
}
const shieldHash: string = load("T5b-shield-status-after-pause").authenticatedStatus.response.body.swapDetails.nearTxHashes[0];
const shieldTx = await rpc("https://rpc.fastnear.com", "tx", { tx_hash: shieldHash, sender_account_id: "intents.near", wait_until: "NONE" });
record("T5b", "privacy-shield", { collectedAt: new Date().toISOString(), summary: nearDetail(shieldHash, shieldTx.response?.result), raw: shieldTx });

const brief = Object.fromEntries(Object.entries(out).map(([k, v]) => {
  const x = v as { status: unknown; explorerPage: unknown; base: unknown; nearTxs: { hash: string; mentionsTreasury: boolean; mentionsRecipient: boolean; logCount: number }[] };
  return [k, { status: x.status, explorerPage: x.explorerPage, base: x.base, nearTxs: x.nearTxs.map((n) => ({ hash: n.hash, logCount: n.logCount, treasury: n.mentionsTreasury, recipient: n.mentionsRecipient })) }];
}));
console.log(JSON.stringify(brief, null, 1));
