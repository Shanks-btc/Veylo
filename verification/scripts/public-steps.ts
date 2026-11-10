// Credential-free partial steps: T10 step 1 (catalog), T7 step 1 (facilitator /supported),
// and the sources read for the T9 research item. Sends no keys and moves no funds.
// Run: npx tsx scripts/public-steps.ts
import { record } from "../_util.js";

const INTENTS_COMMIT = "32cd1f9788a347908164fbcc56525dc6542f158f";
const intentsSource = (path: string) =>
  `https://raw.githubusercontent.com/near/intents/${INTENTS_COMMIT}/${path}`;

const T9_SOURCES = [
  "https://docs.near-intents.org/integration/verifier-contract/signing-intents.md",
  "https://docs.near-intents.org/integration/verifier-contract/account-abstraction.md",
  "https://docs.near.org/protocol/access-keys.md",
  "https://raw.githubusercontent.com/near/NEPs/master/neps/nep-0413.md",
  intentsSource("contracts/defuse/core/src/engine/mod.rs"),
  intentsSource("contracts/defuse/core/src/intents/account.rs"),
  intentsSource("contracts/defuse/src/accounts.rs"),
  intentsSource("contracts/defuse/src/contract/accounts/mod.rs"),
  intentsSource("contracts/defuse/src/contract/intents/state.rs"),
  intentsSource("contracts/defuse/core/src/payload/multi.rs"),
  intentsSource("contracts/defuse/src/contract/accounts/account/mod.rs"),
];

async function get(url: string) {
  const started = Date.now();
  const request = { method: "GET", url };
  try {
    const res = await fetch(url);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON is kept verbatim as text.
    }
    return {
      ranAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      request,
      response: { status: res.status, headers: Object.fromEntries(res.headers), body },
    };
  } catch (err) {
    return {
      ranAt: new Date().toISOString(),
      latencyMs: Date.now() - started,
      request,
      error: {
        message: err instanceof Error ? err.message : String(err),
        cause: err instanceof Error ? String(err.cause) : undefined,
      },
    };
  }
}

console.log(record("T10", "catalog", await get("https://cloud-api.near.ai/v1/model/list")));
console.log(record("T7", "supported", await get("https://x402.mikedotexe.com/supported")));

const sources = [];
for (const url of T9_SOURCES) sources.push(await get(url));
console.log(record("T9", "research-sources", { intentsCommit: INTENTS_COMMIT, sources }));
for (const s of sources) console.log(s.response?.status ?? "ERROR", s.request.url);
