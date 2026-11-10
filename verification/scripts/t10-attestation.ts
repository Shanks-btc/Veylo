// T10 steps 2-3: chat completion and attestation for three fixed models. No catalog fetch.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { record, redact } from "../_util.js";

const BASE = "https://cloud-api.near.ai/v1";
const MODELS = ["Qwen/Qwen3.6-35B-A3B-FP8", "Qwen/Qwen3.8-27B", "z-ai/glm-5.3-flash"];
const KEY = process.env.NEARAI_API_KEY?.trim();
if (!KEY) {
  console.log("T10 stopped: NEARAI_API_KEY is not set.");
  process.exit(1);
}

async function call(url: string, init: { method: string; headers: Record<string, string>; body?: string }) {
  const started = Date.now();
  const request = { ...init, url, body: init.body ? JSON.parse(init.body) : undefined };
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(180_000) });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON is kept verbatim as text.
    }
    return { latencyMs: Date.now() - started, request, response: { status: res.status, headers: Object.fromEntries(res.headers), body } };
  } catch (err) {
    return {
      latencyMs: Date.now() - started,
      request,
      error: { message: err instanceof Error ? err.message : String(err), cause: err instanceof Error ? String(err.cause) : undefined },
    };
  }
}

// Prices come from the saved catalog evidence; only these two fields are read.
type Price = { amount: number; scale: number };
type CatalogModel = { modelId: string; inputCostPerToken: Price; outputCostPerToken: Price };
const catalog: CatalogModel[] = JSON.parse(readFileSync(new URL("../results/T10-catalog.json", import.meta.url), "utf8")).response.body.models;

const auth = { Authorization: `Bearer ${KEY}` };
const runs = [];
for (const model of MODELS) {
  const completion = await call(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Return the word OK." }] }),
  });
  const nonce = randomBytes(32).toString("hex");
  const query = new URLSearchParams({ model, signing_algo: "ecdsa", nonce, provider: "near" });
  const attestation = await call(`${BASE}/attestation/report?${query}`, { method: "GET", headers: auth });
  runs.push({ model, nonce, completion, attestation });
}

const jsonPath = record("T10", "attestation", { ranAt: new Date().toISOString(), runs });

/* eslint-disable @typescript-eslint/no-explicit-any */
const rows = runs.map((run) => {
  const c: any = run.completion.response?.body;
  const a: any = run.attestation.response?.body;
  const list: any[] = Array.isArray(a?.model_attestations) ? a.model_attestations : [];
  const usage = c?.usage;
  const price = catalog.find((m) => m.modelId === run.model);
  const cost =
    usage && price
      ? (usage.prompt_tokens * price.inputCostPerToken.amount + usage.completion_tokens * price.outputCostPerToken.amount) / 10 ** price.inputCostPerToken.scale
      : undefined;
  return {
    model: run.model,
    completionStatus: run.completion.response?.status ?? "request failed",
    latencyMs: run.completion.latencyMs,
    answer: c?.choices?.[0]?.message?.content,
    usage,
    cost,
    attestationStatus: run.attestation.response?.status ?? "request failed",
    modelAttestations: list.length,
    gatewayNonceMatch: a?.gateway_attestation?.request_nonce === undefined ? "absent" : a.gateway_attestation.request_nonce === run.nonce,
    modelNonceMatches: list.map((m) => (m?.request_nonce === undefined ? "absent" : m.request_nonce === run.nonce)),
    modelAttestationFields: list[0] ? Object.keys(list[0]) : [],
    completionError: run.completion.response?.status === 200 ? undefined : (run.completion.response?.body ?? run.completion.error),
    attestationError: run.attestation.response?.status === 200 ? undefined : (run.attestation.response?.body ?? run.attestation.error),
  };
});

const pass = rows.some((r) => r.modelAttestations > 0 && r.modelNonceMatches.length > 0 && r.modelNonceMatches.every((m) => m === true));
const table = rows
  .map((r) => `| \`${r.model}\` | ${r.completionStatus} | ${r.latencyMs} ms | ${r.usage?.prompt_tokens ?? "n/a"} / ${r.usage?.completion_tokens ?? "n/a"} / ${r.usage?.total_tokens ?? "n/a"} | ${r.cost === undefined ? "n/a" : `$${r.cost.toFixed(9)}`} | ${r.attestationStatus} | ${r.modelAttestations > 0 ? `yes (${r.modelAttestations})` : "no"} | ${r.gatewayNonceMatch} | ${r.modelNonceMatches.join(", ") || "n/a"} |`)
  .join("\n");
const errors = rows.filter((r) => r.completionError || r.attestationError).map((r) => `- \`${r.model}\`: \`${JSON.stringify({ completion: r.completionError, attestation: r.attestationError })}\``);

const note =
  `# T10 chat completion and attestation\n\n` +
  `Attestation criterion (model-level attestation carrying our nonce): **${pass ? "met" : "not met"}**. Completions returning HTTP 200: **${rows.filter((r) => r.completionStatus === 200).length} of ${rows.length}**.\n\n` +
  `| Model | Chat HTTP | Completion latency | Tokens (prompt / completion / total) | Cost from catalog prices | Attestation HTTP | \`model_attestations\` non-empty | Gateway \`request_nonce\` matches | Model \`request_nonce\` matches |\n|---|---|---|---|---|---|---|---|---|\n${table}\n\n` +
  `- Prompt: \`Return the word OK.\` Answers: ${rows.map((r) => `\`${r.model}\` returned ${JSON.stringify(r.answer)}`).join("; ")}.\n` +
  `- Requests: \`provider=near\`, \`signing_algo=ecdsa\`, a fresh 64-hex nonce for each attestation. No catalog fetch; prices are from \`T10-catalog.json\`.\n` +
  `- Not done: the Intel quotes and signatures were not cryptographically verified. This records what the API returned.\n` +
  (errors.length ? `\n## Exact errors\n\n${errors.join("\n")}\n` : "") +
  `\nRaw evidence: \`T10-attestation.json\`. No funds moved; no tx hashes.\n`;
writeFileSync(new URL("../results/T10-attestation.md", import.meta.url), redact(note) as string);

console.log(`T10 attestation criterion ${pass ? "met" : "not met"}; completions OK: ${rows.filter((r) => r.completionStatus === 200).length}/${rows.length}`);
console.log(JSON.stringify(redact(rows), null, 1));
console.log(jsonPath);
