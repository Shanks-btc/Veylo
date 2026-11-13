# VERIFICATION.md — Phase 2: Route Verification (NEAR Mainnet)

Product: Private borderless payroll and agent-payment infrastructure on NEAR.
Owner: Kelvin (executor) · Architecture review: CTO
Status: **Not started**

---

## 0. Purpose and rules

This phase proves every external capability the architecture depends on **before any product code is written**. Each test answers one architecture question. A failed critical test changes the route; it is never deferred.

Rules for Claude Code and the executor:

1. **Throwaway scripts only.** All scripts live in `verification/` (TypeScript, Node 20+). No product code, no shared modules, no frameworks. Nothing here gets imported later.
2. **Mainnet only, tiny amounts.** NEAR Intents has no testnet. Never move more than **$2 per test** unless the test says otherwise.
3. **Secrets live in `verification/.env` only.** `.env` must be in `.gitignore` before the first script runs. Never print keys or JWTs to logs or result files.
   **Redaction policy (`_util.ts`), two layers:**
   - *By value (primary):* every secret value loaded from `.env` (`*_SECRET_KEY`, `ONECLICK_JWT`, `NEARAI_API_KEY`, `X402_FACILITATOR_API_KEY`) plus any `accessToken` / `refreshToken` returned at runtime is replaced with `"[REDACTED]"` anywhere in the serialized output, including inside URLs and nested strings.
   - *By exact key name (backup, case-insensitive, no substring matching):* `authorization`, `x-api-key`, `secret_key`, `private_key`, `api_key`, `jwt`, `accesstoken`, `refreshtoken`.
   - Public evidence must stay visible: `public_key`, token-usage fields (`*_tokens`), attestation fields, and intent signatures **after** submission.
4. **Record raw evidence.** Every test writes its raw request (secrets redacted) and full raw response to `verification/results/Txx-<name>.json`, plus a short `verification/results/Txx-<name>.md` note: what happened, tx hashes, explorer links, pass/fail.
5. **Do not interpret, record.** If a response is surprising, record it verbatim and stop that test. The CTO interprets.
6. **Do not invent fields.** Request shapes below come from official docs (sources in §5). If an endpoint rejects a field, record the exact error; do not guess an alternative.
7. **Git:** Kelvin reviews `git status` and handles every commit and push. No co-author tags.

---

## 1. Prerequisites

### Accounts (NEAR mainnet, separate keys, small balances)
| Env var | Role | Funding |
|---|---|---|
| `TREASURY_ACCOUNT_ID` / `TREASURY_SECRET_KEY` | Company treasury (holds USDC) | ~$10 USDC + ~1 NEAR |
| `AGENT_ACCOUNT_ID` / `AGENT_SECRET_KEY` | AI agent payer (x402) | ~$1 USDC + ~0.2 NEAR. **Full-access key required** (x402 SignedDelegate) |
| `SELLER_ACCOUNT_ID` | x402 seller / API payee | USDC storage registration only |
| `CONTRACTOR_SOLANA_ADDRESS` / `CONTRACTOR_EVM_ADDRESS` / `CONTRACTOR_TRON_ADDRESS` | Payout recipients on other chains (one EVM address serves Base and Arbitrum) | Addresses only |
| `RELAYER_ACCOUNT_ID` / `RELAYER_SECRET_KEY` | Gas sponsor (T8) | ~1 NEAR |
| `USER_ACCOUNT_ID` / `USER_SECRET_KEY` | End user who signs delegate actions (T8) | ~0.05 NEAR (must stay unchanged by the test) |
| `ROLES_CONTRACT_ACCOUNT_ID` / `ROLES_CONTRACT_SECRET_KEY` | Account the T9 test contract deploys to | ~3 NEAR (storage; exact cost recorded in T9) |
| `ROLES_TEST_ACCOUNT_ID` / `ROLES_TEST_SECRET_KEY` | Account that receives the restricted function-call key (T9) | ~0.1 NEAR |

### API credentials
| Env var | Source | Used by |
|---|---|---|
| `ONECLICK_JWT` | partners.near-intents.org | T2–T6 (send as `X-API-Key`) |
| `NEARAI_API_KEY` | cloud.near.ai (`sk-…`) | T10 |
| `X402_FACILITATOR_URL` / `X402_FACILITATOR_API_KEY` | See T7 | T7 |

### Pending action (blocking T3 and T5b)
- Confidential Intents enablement request submitted via intents.near.org form: **[ ] yes / date: ____**

### Known constants (to be confirmed by T1, do not trust until confirmed)
- 1Click base URL: `https://1click.chaindefuser.com`
- Circle USDC on NEAR mainnet contract: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
- Expected 1Click asset ID: `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (**unconfirmed**)
- NEAR AI Cloud base URL: `https://cloud-api.near.ai/v1`

---

## 2. Tests

Run order: **T1 → T2 → T10 → T3 → T4 → T5 → T6 → T7 → T8 → T9.**
T1, T2, T10 need no funds or approvals.

---

### T1 — Token catalog
**Question:** What are the exact asset IDs and decimals for USDC on NEAR and each payout asset?

```
GET https://1click.chaindefuser.com/v0/tokens
```

**Record:** full response. Extract into `results/T1-assets.md` a table of `assetId`, `blockchain`, `symbol`, `decimals`, `contractAddress` for:
USDC (near), USDC (sol), USDC (base), USDC (arb), USDT (tron), USDT (near).

**Pass:** USDC on NEAR present with the contract above; at least 3 payout assets on other chains present.
**Informs:** supported payout currencies list; decimals handling.

---

### T2 — Dry payout quotes (EXACT_OUTPUT)
**Question:** Can the treasury pay an exact salary amount to each payout asset, and at what fee and time?

Payroll pays **exact** amounts, so use `EXACT_OUTPUT`. For each payout asset from T1:

```
POST https://1click.chaindefuser.com/v0/quote
Headers: Content-Type: application/json, X-API-Key: $ONECLICK_JWT
Body:
{
  "dry": true,
  "swapType": "EXACT_OUTPUT",
  "slippageTolerance": 100,
  "originAsset": "<USDC on NEAR assetId from T1>",
  "depositType": "ORIGIN_CHAIN",
  "destinationAsset": "<payout assetId from T1>",
  "amount": "<10 units of destination asset, smallest unit>",
  "recipient": "<contractor address on destination chain>",
  "recipientType": "DESTINATION_CHAIN",
  "refundTo": "$TREASURY_ACCOUNT_ID",
  "refundType": "ORIGIN_CHAIN",
  "deadline": "<now + 10 minutes, ISO>"
}
```

Repeat once **without** `X-API-Key` for one route to measure the unauthenticated fee difference.

**Record:** full responses. Table per route: `amountIn`, `amountOut`, implied fee in USD and bps, `timeEstimate`, any error.
**Pass:** all routes return a quote; stablecoin routes show the low partner fee.
**Informs:** fee model shown to customers; quote expiry handling; which routes we support at launch.

---

### T3 — Confidential access check (dry)
**Question:** Is our integration enabled for Confidential Intents, and on which path?

**T3a, foreign-to-foreign:** identical to one T2 request, plus:
```
"confidentiality": "basic"
```
Then repeat with `"confidentiality": "advanced"`.

**T3b, embedded balance:** a dry quote with:
```
"depositType": "CONFIDENTIAL_INTENTS",
"recipientType": "DESTINATION_CHAIN",
"refundType": "CONFIDENTIAL_INTENTS"
```
(other fields as T2; `refundTo` = treasury account).

**Record:** full responses, especially exact error text and codes.
**Pass:** a quote is returned. **"Not enabled" style errors are also a valid result.** Record them exactly; do not retry with other fields.
**Informs:** the entire privacy architecture (see §3, decision D1).

---

### T4 — Real payout, origin-chain deposit ($1)
**Question:** Does the full payout path work end to end from a NEAR treasury?

1. Request a **live** quote (`"dry": false`), same shape as T2, `amount` = 1 unit of a USDC payout asset (e.g. USDC on Solana).
2. From the treasury, send the quote's `amountIn` of USDC to the quote's `depositAddress` via `ft_transfer` on the USDC contract.
   - Record whether the deposit address needed NEP-145 storage registration first. If the transfer fails, record the exact error and stop.
3. Optionally notify:
```
POST https://1click.chaindefuser.com/v0/deposit/submit
Body: { "depositAddress": "<from quote>", "txHash": "<treasury ft_transfer hash>" }
```
4. Poll until terminal:
```
GET https://1click.chaindefuser.com/v0/status?depositAddress=<from quote>
```
Terminal statuses: `SUCCESS`, `REFUNDED`, `FAILED`, `INCOMPLETE_DEPOSIT`.

**Record:** every status transition with timestamp; origin and destination tx hashes; explorer links (NEAR, destination chain, explorer.near-intents.org); total seconds to `SUCCESS`; amount received.
**Pass:** `SUCCESS`, recipient received exactly the quoted amount.
**Informs:** payout state machine; real settlement times; what the public chain reveals on this path (note what is visible on NearBlocks for the treasury).

---

### T5 — Payout from treasury Intents balance (signed intent)
**Question:** Can the treasury hold funds inside NEAR Intents and pay out by signing intents, without an on-chain deposit per payout? This is how batch payroll would work.

1. Deposit ~$3 USDC from the treasury into its public Intents balance (method per NEAR Intents docs, "deposit to intents.near"). Record the tx.
2. Live quote with `"depositType": "INTENTS"`, `"refundType": "INTENTS"`, `"refundTo": "$TREASURY_ACCOUNT_ID"`, `"recipientType": "DESTINATION_CHAIN"`, `EXACT_OUTPUT` 1 USDC to a contractor.
3. Generate the intent:
```
POST https://1click.chaindefuser.com/v0/generate-intent
Headers: X-API-Key: $ONECLICK_JWT
Body: { "type": "swap_transfer", "standard": "nep413", "signerId": "$TREASURY_ACCOUNT_ID", "depositAddress": "<from quote>" }
```
4. Sign the returned `intent.payload` with the treasury key (NEP-413), **unmodified**.
5. Submit:
```
POST https://1click.chaindefuser.com/v0/submit-intent
Headers: X-API-Key: $ONECLICK_JWT
Body: { "type": "swap_transfer", "signedData": { ...intent, "public_key": "ed25519:…", "signature": "ed25519:…" } }
```
6. Poll `/v0/status` as in T4.
7. **Batch probe:** create two quotes for two contractors, then generate and submit both. Record whether each needs its own signature (expected) and whether they settle independently.

**Record:** all raw responses; which public key signed; whether that key had to be registered with `intents.near` first (record any "invalid signer/public key" error verbatim); settlement times.
**Pass:** both payouts `SUCCESS` with no per-payout on-chain treasury deposit.
**Informs:** decision D2 (payroll execution model) and D3 (signing authority).

**T5b (only if T3b passed):** repeat T5 with funds shielded into the confidential balance (`depositType: INTENTS → recipientType: CONFIDENTIAL_INTENTS`, then pay out with `depositType: CONFIDENTIAL_INTENTS`). Record what NearBlocks shows for the treasury before and after.

---

### T6 — Reading the confidential treasury balance
**Question:** Can our dashboard read the treasury's private balance and history?

1. Obtain a User-Session token: the treasury signs an empty intent and posts it as `signedData` to `POST /v0/auth/authenticate` (exact shape: "Authenticate User with Signed Data" page, §5).
2. `GET /v0/account/balances` and `GET /v0/account/history` with `Authorization: Bearer <accessToken>`.
3. Refresh once via `POST /v0/auth/refresh` with `{ "refreshToken": "…" }`.

**Record:** response shapes; token lifetimes (`expiresIn`, `refreshExpiresIn`).
**Pass:** balances returned for the treasury account.
**Informs:** how the dashboard shows treasury and payout history without exposing it publicly; session design.

---

### T7 — Agent pays an API via x402 (mainnet, $0.01)
**Question:** Can an AI agent account pay an HTTP 402–protected endpoint in USDC, gasless for the agent?

Facilitator options (choose one, record which):
- **A. FastNEAR reference facilitator** `https://x402.mikedotexe.com` (mainnet, Circle USDC). `POST /verify` and `/settle` need a manually approved per-instance `X-API-Key` (see FastNEAR reference-access guide). Check `GET /supported` first (public).
- **B. Self-hosted** `fastnear/x402-facilitator` (open source) with our relayer account.

Steps:
1. `GET <facilitator>/supported`, record.
2. Seller: a minimal local HTTP route protected with `createNearResourceServer` from `@fastnear/x402/server`, priced at $0.01 USDC, network `near:mainnet`. Ensure `SELLER_ACCOUNT_ID` is storage-registered on the USDC contract.
3. Payer: `createLocalNearSigner` (`@fastnear/x402/node`) with the **agent's full-access key** and `createNearPaymentFetch({ signer, network: "near:mainnet" })`, calling the seller route.

**Record:** the raw 402 challenge; the paid response; settlement tx hash; agent's NEAR balance before/after (expected unchanged); USDC moved.
**Pass:** 200 response after payment; agent spent only USDC.
**Informs:** decision D4 (agent wallet model). Note what is public about agent spend on NearBlocks.

---

### T8 — Gasless relay for our own actions
**Question:** Can our relayer pay gas for user actions on our own contract, and refuse everything else?

Use NEP-366 meta transactions: a user signs a `SignedDelegate`, our relayer wraps and submits it. Reference: FastNEAR "Gasless meta-transactions" page and the NEAR docs meta-transaction relayer tutorial (§5). Claude Code must read both before writing the script.

1. User account signs a delegate action calling a harmless method on a test contract.
2. Relayer submits it.
3. Relayer receives a delegate action targeting a **different** contract; the relayer's allowlist must reject it before submission.

**Record:** user NEAR balance before/after (expected unchanged); relayer gas spent; the rejection behavior.
**Pass:** step 2 succeeds gaslessly; step 3 is rejected by our allowlist.
**Informs:** relayer design (allowlist, rate limits, float monitoring).

---

### T9 — Access-key permission boundaries
**Question:** What can a function-call key actually be restricted to, and does that restriction help secure the treasury?

1. Deploy a minimal test contract with `propose_run()` and `approve_run()`. Record storage cost in NEAR.
2. Add a function-call access key to a test account restricted to receiver = test contract, method_names = `["propose_run"]`, with an allowance.
3. Using that key: call `propose_run` (expect success), call `approve_run` (expect failure), attempt an `ft_transfer` on USDC (expect failure).

**Research item (record findings, no guessing):** which keys can sign NEP-413 intents for an account on `intents.near`. Read the NEAR Intents verifier docs ("Signing Intents", account/public-key management). Can a function-call key sign intents, or only keys registered with `intents.near`?

**Record:** each call's exact result or error; the research findings with source links.
**Pass:** restrictions behave as expected.
**Informs:** decision D3 (signing authority and roles). This is security-critical.

---

### T10 — NEAR AI Cloud private inference and attestation
**Question:** Which models are truly TEE-private, and can we prove it?

1. Public catalog:
```
GET https://cloud-api.near.ai/v1/model/list
```
2. Chat completion on a candidate model:
```
POST https://cloud-api.near.ai/v1/chat/completions
Headers: Authorization: Bearer $NEARAI_API_KEY
Body: { "model": "<candidate>", "messages": [{ "role": "user", "content": "Return the word OK." }] }
```
3. Attestation for that model:
```
GET https://cloud-api.near.ai/v1/attestation/report?model=<candidate>&signing_algo=ecdsa&nonce=<random 64-char hex>&provider=near
Headers: Authorization: Bearer $NEARAI_API_KEY
```
Repeat step 3 for 2–3 candidate models.

**Record:** catalog entries for candidates; whether each attestation response contains non-empty `model_attestations` (vs gateway-only); `request_nonce` matches ours; latency and cost of the completion.
**Pass:** at least one capable model returns a model-level TEE attestation with our nonce.
**Informs:** decision D5 (AI agent model choice) and the "prove the AI ran privately" demo feature.

### S-N — Direct public USDC payout to a NEAR account (mainnet, ≤ $0.10) — PREPARED, NOT RUN

**Status:** prepared in slice W3 (L46). **Not run:** it moves real funds on mainnet, so it needs the founder's explicit approval first. Until it passes, the direct NEAR route (`usdc-near`) is "Coming soon" in the app and refused by the API.

**Question:** Can the treasury pay public USDC from its NEAR Intents balance to a NEAR named account, through 1Click signed-intent execution, gaslessly? (Phase 2 proved confidential NEAR payouts in T5b/T5c and public payouts to Base/Arbitrum in T5. Never public USDC to a NEAR account.)

**Script:** `verification/scripts/s-n-near-direct.ts`. It refuses to start unless `S_N_FOUNDER_APPROVED=yes` is set for that one run.

**Inputs (from `verification/.env`, never printed):** `ONECLICK_JWT`, `TREASURY_ACCOUNT_ID` and `TREASURY_SECRET_KEY` (the dev treasury, never the founder's personal wallet), `CONTRACTOR_NEAR_ACCOUNT` (a NEAR named account the team controls).

**Steps:**
1. Read the treasury's Intents USDC balance (`intents.near` `mt_balance_of`) and the recipient's USDC balance (`ft_balance_of` on the USDC contract).
2. Live quote: `EXACT_OUTPUT`, `amount` 100000 (0.10 USDC), `originAsset` and `destinationAsset` both USDC on NEAR, `depositType` `INTENTS`, `recipientType` `DESTINATION_CHAIN`, `refundTo` the treasury. Stop if `amountIn` > 0.10 USDC (L11 cap) or above the balance, or `amountOut` ≠ 100000.
3. `generate-intent`. Stop unless the standard is `nep413`, the verifier (`recipient`) is `intents.near`, the signer is the treasury, the nonce is canonical, and the total USDC debit is in (0, 0.10].
4. Sign the payload unmodified; verify locally; record the signed intent (public key and signature, no secret).
5. `submit-intent`; record the `intentHash`.
6. Poll `/v0/status` every 5 s until terminal (30 min max); record every transition.
7. After 60 s, read both balances again; record the recipient's delta and each NEAR transaction's explorer link (`https://nearblocks.io/txns/<hash>`).

**Record (to `verification/results/`, gitignored):** quote, generate-intent, signed intent, submit-intent, status transitions, balances before and after, explorer links.
**Pass:** status `SUCCESS`; the recipient's USDC grows by exactly 0.10; the treasury's debit is ≤ 0.10 USDC; the recipient paid no gas; the transaction is visible on the NEAR explorer.
**Unlocks:** enabling `usdc-near` in `ROUTE_AVAILABILITY` (`packages/core/src/routes.ts`), payout verifier `intents.near` in browser gate C, and a new L-row.

### S-P — Contractor portal cash-out, live (mainnet, ≤ $0.05) — PREPARED, NOT RUN

**Status:** prepared in slice W5 (D3). **Not run:** it moves real funds on mainnet, so it needs the founder's explicit approval first.

**Question:** Does the portal's cash-out (a contractor moving their own confidential USDC to an address they type) work end to end? The browser checks for it are built and tested on recorded data (`apps/web/src/portal/cash-out.ts`); the flow itself was proven in T5d (docs/EVIDENCE.md rows 24 to 26).

**Script:** `verification/scripts/s-p-cashout.ts`. It refuses to start unless `S_P_FOUNDER_APPROVED=yes` is set for that one run, then runs `t5d.ts` unchanged, with T5d's own caps (0.03 USDC out, at most 0.05 USDC leaving the balance) and its own stops.

**Inputs (from `verification/.env`, never printed):** the same as T5d: `ONECLICK_JWT`, `TREASURY_ACCOUNT_ID`, `RECIPIENT_NEAR_ACCOUNT_ID`, `RECIPIENT_NEAR_SECRET_KEY` (a dev account, never the founder's personal wallet) and `CONTRACTOR_EVM_ADDRESS`.

**Pass:** as T5d: status `SUCCESS`, the recipient address receives exactly 0.03 USDC, and the privacy check finds no public link from the treasury.
**Unlocks:** switching on in-app cash-out. (Slice W6 wired the portal's private balance, which only reads: a contractor's wallet signs an empty intent to open a read-only 1Click session, the same mechanism T6 proved for the treasury. Cash-out, which moves money, stays "coming soon" until this spike passes.)

### S-F1 — Fund a treasury with USDC on NEAR through a 1Click deposit address (mainnet, ≤ $0.50) — PREPARED, NOT RUN

**Status:** prepared in slice W6 (part 3a). **Not run:** it sends real USDC on mainnet, so it needs the founder's explicit approval first. Until it passes, the app marks this funding path "not yet tested live".

**Question:** Does 1Click quote and settle a same-asset deposit (USDC on NEAR in, USDC on the treasury's Intents balance out) through a deposit address, gaslessly for the person who funds? No same-asset quote has ever been made (`FUNDING_ORIGINS` marks it `unproven`). If 1Click refuses the quote, the refusal is the finding, and the fallback is a direct `ft_transfer_call` of USDC to `intents.near`.

**Script:** `verification/scripts/s-f1-fund-usdc-near.ts`. It refuses to start unless `S_F1_FOUNDER_APPROVED=yes` is set for that one run.

**Inputs (from `verification/.env`, never printed):** `ONECLICK_JWT`, `TREASURY_ACCOUNT_ID` (the Intents account that receives), `FUNDER_NEAR_ACCOUNT_ID` and `FUNDER_NEAR_SECRET_KEY` (a dev account holding at least 0.45 USDC and a little NEAR, never a personal wallet).

**Steps:** read both balances; live `EXACT_INPUT` quote, `amount` 450000 (0.45 USDC), `depositType` `ORIGIN_CHAIN`, `recipientType` `INTENTS`, `refundTo` the funder; stop unless `amountIn` equals the amount; register the deposit address with the USDC contract if it isn't (about 0.00125 NEAR); `ft_transfer` the quoted `amountIn` to the deposit address; poll `/v0/status` every 5 s (30 min max); read balances again.

**Pass:** status `SUCCESS` and the treasury's Intents USDC grows by at least the quote's `minAmountOut`.
**Unlocks:** removing the "not yet tested live" note on USDC-on-NEAR funding, and a new L-row.

### S-F2 — Fund a treasury with NEAR, converted to USDC (mainnet, ≤ $0.50 of NEAR) — PREPARED, NOT RUN

**Status:** prepared in slice W6 (part 3a). **Not run:** it sends real NEAR on mainnet, so it needs the founder's explicit approval first. Until it passes, "Fund with NEAR (converted to USDC)" is "coming soon" in the app and refused by the API.

**Question:** Does 1Click convert NEAR sent to a deposit address into USDC on the treasury's Intents balance, with the rate, fee and USDC received the quote promised?

**Script:** `verification/scripts/s-f2-fund-near.ts`. It refuses to start unless `S_F2_FOUNDER_APPROVED=yes` is set for that one run. It sizes the amount from 1Click's listed NEAR price (exact bigint math) and stops unless the amount's USD value is within 0.50.

**Inputs (from `verification/.env`, never printed):** `ONECLICK_JWT`, `TREASURY_ACCOUNT_ID`, `FUNDER_NEAR_ACCOUNT_ID` and `FUNDER_NEAR_SECRET_KEY` (a dev account, never a personal wallet).

**Steps:** read the price and both balances; live `EXACT_INPUT` quote for about 0.45 USD of NEAR (`originAsset` `nep141:wrap.near`, `depositType` `ORIGIN_CHAIN`, `recipientType` `INTENTS`); stop unless `amountIn` equals the amount and its value is within the cap; transfer the quoted `amountIn` of NEAR to the deposit address; poll status (30 min max); read balances again.

**Pass:** status `SUCCESS` and the treasury's Intents USDC grows by at least the quote's `minAmountOut`.
**Unlocks:** enabling "near" in `FUNDING_AVAILABILITY` (`packages/core/src/routes.ts`), and a new L-row.

### S-FT — Fund a treasury with USDT on NEAR, converted to USDC (mainnet, ≤ $0.50) — PREPARED, NOT RUN

**Status:** prepared in slice W6 (part 3a addendum). **Not run:** it sends real USDT on mainnet, so it needs the founder's explicit approval first. Until it passes, "Fund with USDT on NEAR (converted to USDC)" is "coming soon".

**Question:** Does 1Click convert USDT sent from NEAR (`nep141:usdt.tether-token.near`) into USDC on the treasury's Intents balance? The token's contract and 1Click's listing of it were checked on 2026-11-12 (T1 lists `usdt.tether-token.near`); nothing has been sent.

**Script:** `verification/scripts/s-ft-fund-usdt.ts`. It refuses to start unless `S_FT_FOUNDER_APPROVED=yes` is set for that one run.

**Inputs (from `verification/.env`, never printed):** `ONECLICK_JWT`, `TREASURY_ACCOUNT_ID`, `FUNDER_NEAR_ACCOUNT_ID` and `FUNDER_NEAR_SECRET_KEY` (a dev account holding at least 0.45 USDT and a little NEAR).

**Steps:** as S-F1, with USDT as the origin asset (`ft_transfer` on `usdt.tether-token.near`, registering the deposit address first if needed).

**Pass:** status `SUCCESS` and the treasury's Intents USDC grows by at least the quote's `minAmountOut`.
**Unlocks:** enabling "usdt-near" in `FUNDING_AVAILABILITY`, and a new L-row.

### S-NR — Pay a contractor in NEAR (mainnet, ≤ $0.10) — PREPARED, NOT RUN

**Status:** prepared in slice W6 (part 3b). **Not run:** it moves real funds on mainnet, so it needs the founder's explicit approval first. Until it passes, the NEAR payout route (`near-direct`) is "coming soon" in the app and refused by the API.

**Question:** Pay from the treasury's USDC, `EXACT_OUTPUT` of NEAR to a NEAR named account. What does the recipient actually receive, native NEAR on their account, or wrapped NEAR (`wrap.near`)? The answer decides how a NEAR payout is described to a contractor and how gate C reads the delivered amount.

**Script:** `verification/scripts/s-nr-near-payout.ts`. It refuses to start unless `S_NR_FOUNDER_APPROVED=yes` is set for that one run. It refuses to sign unless the intent spends only USDC and at most 0.10 USDC.

**Inputs (from `verification/.env`, never printed):** `ONECLICK_JWT`, `TREASURY_ACCOUNT_ID` and `TREASURY_SECRET_KEY` (the dev treasury), `CONTRACTOR_NEAR_ACCOUNT` (a NEAR named account the team controls).

**Steps:** read the NEAR price; read the treasury's Intents USDC, the recipient's native NEAR and its `wrap.near` balance; live `EXACT_OUTPUT` quote for about 0.08 USD of NEAR (`destinationAsset` `nep141:wrap.near`, `recipientType` `DESTINATION_CHAIN`); the same intent checks as S-N; sign, submit, poll; read all three balances again.

**Pass:** status `SUCCESS`, the recipient receives the requested NEAR amount, and the result records which form arrived.
**Unlocks:** enabling `near-direct` in `ROUTE_AVAILABILITY`, the NEAR variant of gate C against a real quote, and a new L-row. Confidential NEAR payouts are a separate question; the docs checked do not describe one, so the route is direct only.

### S-EW — The Veylo embedded wallet on mainnet (≤ $0.10) — PREPARED, NOT RUN

**Status:** prepared in slice W6 (embedded wallet addendum). **Not run:** it moves real funds on mainnet, so it needs the founder's explicit approval first.

**Question:** Does NEAR Intents accept an intent signed by the key of a Veylo embedded wallet (an implicit 64-hex account whose key is derived from a recovery phrase)? The embedded wallet's own tests prove the derivation, the encryption and the signature offline; this proves the verifier agrees.

**Script:** `verification/scripts/s-ew-embedded-wallet.ts`. It refuses to start unless `S_EW_FOUNDER_APPROVED=yes` is set for that one run. It needs only the throwaway wallet's public account id, never its key or recovery phrase.

**Inputs (from `verification/.env`, never printed):** `ONECLICK_JWT`, `TREASURY_ACCOUNT_ID` and `TREASURY_SECRET_KEY` (the dev treasury), `EW_ACCOUNT_ID` (the implicit account of a throwaway wallet created in the app for this test; never a personal wallet).

**Steps:** read both Intents balances; the dev treasury moves 0.10 USDC to the wallet's Intents balance (`EXACT_OUTPUT`, `INTENTS` to `INTENTS`, same checks as S-N); wait for `SUCCESS`; then the founder signs a transfer of that USDC out in the app with the embedded wallet while the script waits up to 20 minutes for the wallet's balance to drop.

**Pass:** funding `SUCCESS`, and the wallet's Intents USDC drops after the founder signs in the app (the embedded key's intent was accepted).
**Unlocks:** removing "not yet tested on mainnet" from the embedded wallet, and a new L-row.

---

## 3. Decisions these tests unlock

| ID | Decision | Depends on |
|---|---|---|
| D1 | Privacy architecture: foreign-to-foreign confidential payouts vs. confidential treasury balance vs. no confidentiality | T3, T4, T5b |
| D2 | Payroll execution model: on-chain deposit per payout vs. signed intents from an Intents balance | T4, T5 |
| D3 | Signing authority: which key signs payouts, how proposer/approver roles are enforced | T5, T9 |
| D4 | Agent wallet model: dedicated agent accounts funded with capped budgets | T7 |
| D5 | AI model and attestation flow | T10 |
| D6 | Fee and settlement-time disclosures in product UI | T2, T4 |

---

## 4. Known discrepancies in documentation (to be settled by tests)

1. **Unauthenticated fee:** one source cites 0.2%; current 1Click docs state 0.25%. Authenticated partner fee is typically 20 bps, or 1 bp on stablecoin and same-asset multichain routes. T2 measures it.
2. **Confidential access:** NEAR announcements say Confidential Intents is generally available to all integrators via a single parameter; one version of the 1Click quickstart said it is invite-only and requires enablement. The current Confidential Swaps page does not mention gating. T3 settles it.
3. **Privacy scope:** the foreign-to-foreign path makes deposits and withdrawals unlinkable, but the treasury's deposit transfer itself happens on public NEAR. Record exactly what NearBlocks shows in T4/T5/T5b.

---

## 5. Sources (read before writing each script)

- 1Click overview: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart.md
- Making a Request: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request.md
- Confidential Swaps: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/confidential-swaps.md
- Signed Intent Execution: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution.md
- Authentication and User-Session: https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md
- Signing Intents (verifier): https://docs.near-intents.org/integration/verifier-contract/signing-intents.md
- FastNEAR x402: https://js.fastnear.com/x402
- FastNEAR meta-transactions: https://js.fastnear.com/meta-transactions.html
- NEAR meta-transaction relayer tutorial: https://docs.near.org/web3-apps/tutorials/meta-transactions
- NEAR AI Cloud API: https://docs.near.ai/api-reference/introduction.md
- NEAR AI Cloud attestation: https://docs.near.ai/api-reference/attestation/get-attestation-report.md

---

## 6. Results log

| Test | Date | Result | Evidence file | Notes |
|---|---|---|---|---|
| T1 | 2026-11-05 | PASS | `verification/results/T1-tokens.json`, `T1-tokens.md`, `T1-assets.md` | 215 tokens; USDC on NEAR assetId confirmed; 4 of 4 payout assets on other chains. Two USDT rows on `near` (`usdt.tether-token.near` and a `miden-…` asset). |
| T2 | 2026-11-05 | FAIL | `verification/results/T2-quotes.json`, `T2-quotes.md`; earlier run: `T2-quotes-placeholder-run.json`, `T2-quotes-placeholder-run.md` | 0 of 4 routes quoted, with generated wallets. All 9 requests (EXACT_OUTPUT with JWT, EXACT_INPUT diagnostics, one unauthenticated) returned HTTP 400 `Quoting for this pair is not available`. No fee table possible. Unfunded `refundTo` acceptance not established. Diagnostic round (`T2-diagnostic.md`, `T2-diag*.json`): all 3 NEAR-origin dry quotes failed with the same error, including the docs' `wrap.near` example, with either `refundTo` and at 100 USDC; USDC arb -> USDC sol returned a quote (HTTP 201). USDC on NEAR still listed. Second round (`T2-diagnostic-2.md`, `T2-diag7-docs-example-bearer.json`): docs example with `Authorization: Bearer` returned the same error. |
| T3a | 2026-11-05 | PASS (dry quote) | `verification/results/T3a-basic.json`, `T3a-advanced.json`, `T2-diagnostic-2.md` | Both `basic` and `advanced` returned quotes (HTTP 201) on USDC arb -> USDC sol, the only foreign route that quoted. NEAR-origin `ORIGIN_CHAIN` quotes still fail, so not tested from NEAR. No execution or privacy tested. |
| T3b | 2026-11-05 | PASS (dry quote) | `verification/results/T3b-embedded.json`, `T2-diagnostic-2.md` | `CONFIDENTIAL_INTENTS` deposit and refund returned a quote (HTTP 201) for USDC near -> USDC sol, EXACT_OUTPUT 10 USDC. API echoed `confidentiality: basic`, which was not sent. Does not show the integration can execute one. Live shield and a live payout with `depositType: CONFIDENTIAL_INTENTS` later succeeded (`T5b-privacy.md`). |
| T4 | 2026-11-05 | Dropped: not on architecture path (L10) | | |
| T5 | 2026-11-05 | PASS | `verification/results/T5-batch.md`, `T5-batch-*.json`, `T5-c2.md`, `T5-c0-dry-*.json`, `T5-c1-signing-check.json`, `T5-c2-*.json`, `T5-fund.md`, `T5-fund-status.json`, `T5-fund-origin-tx.json`, `T5-fund-dry-quote.json`, `T5-fund-live-quote.json`, `T5-a-funding.json`, `T5-a-funding.md`, `T5-dry-intents-quote.json`, `T2-diagnostic-2.md` | `INTENTS` deposit and refund returned a quote (HTTP 201) for USDC near -> USDC sol, EXACT_OUTPUT 10 USDC: `minAmountIn` 10252892, `amountIn` 10353923, `timeEstimate` 7. Live run stopped at step A (`T5-a-funding.json`, `T5-a-funding.md`): treasury account does not exist on-chain (`UNKNOWN_ACCOUNT`) and holds 0 USDC. Funded instead by 2.0 USDT from BSC through 1Click (`recipientType: INTENTS`): `SUCCESS` 79.4 s after the BSC block, origin tx `0x3b38538e3ca9f818dc451bfb99627ecb404d4030566c090b6385cc09d9e7c711`, destination tx `2cJrzde29v8XgjNR7Dp9mCXfECN8rER23BpGdm7Qi3NW`. Treasury Intents balance 1.997807 USDC (`minAmountOut` 1.977862). Live signed-intent payout, EXACT_OUTPUT 0.50 USDC to Base: `SUCCESS` 27.5 s after submit, intentHash `HSQq4Q9MSkfgpA5DVyeoPWJknaaoS32ZcCWwEYZrGw34`, destination tx `0xb8f7cd70174d9c3a951f137d1de7b76e4dcfdffd1fc11c78dc290b1fc0fb4aa8`. Recipient received 0.500000 USDC; treasury Intents balance 1.997807 -> 1.495304 (net 0.502503, equals `minAmountIn`). Never-created implicit account accepted as signer, with no NEAR and no `add_public_key` call. Batch probe: two EXACT_OUTPUT 0.10 USDC payouts (Base, Arbitrum) submitted 0.223 s apart, each with its own nonce and signature from the same key; both `SUCCESS` about 33 s after submit, no nonce or ordering issues in this run. Destination txs `0x2480e40d66dc065a86156c81fc97a7a6c48ed51b3cde249be78760976fb8dc48` (Base), `0x124cbe812cf6d5d2a12ae91fa92f09a1c9d6d3c19f783b5be292d849347fdc4e` (Arbitrum). Treasury Intents balance 1.495304 -> 1.287557. No per-payout on-chain treasury deposit. NearBlocks not read; T5b not run. |
| T5b | 2026-11-05 | PASS (one payout; no batch) | `verification/results/T5b-privacy.md`, `T5b-T6-partial.md`, `T5b-shield-*.json`, `T5b-payout-*.json`, `T5b-privacy-*.json` | Shield: public Intents 1.287557 -> 0.987557, confidential 0.300000. Confidential EXACT_OUTPUT 0.10 USDC to Base: `SUCCESS` 24.7 s after submit, payload verifier `intents.far`, intentHash `6xZ679czkrDiVHJVwFkqdASMxJdqfQk4PujDRJLfbjrf`, Base tx `0x4bf4fa942cecd5e031288d33153698a84919cfb3b18bbb3c1423376bd39fcf85`. Confidential 0.300000 -> 0.195177; public unchanged. Observer checks: status 404, explorer HTML shows no details, treasury in no listed payout tx. Still public: payout recipient and amount, and the shield with its amount and the treasury. Same Base sender as the public payout. Browser check of the explorer page outstanding. |
| T5c | 2026-11-05 | PASS (private receipt) | `verification/results/T5c.md`, `T5c-*.json` | Confidential treasury to confidential recipient, EXACT_OUTPUT 0.05 USDC: `SUCCESS` 5.3 s after submit, no fees, payload verifier `intents.far`, intentHash `EsJNKVAZWwXRtpioeNe59vg8cL87xiTinwvsBsrzVDU1`. Treasury confidential 0.195177 -> 0.145177; recipient's own session shows 0.050000. Public checks (`mt_balance_of`, `mt_tokens_for_owner`, unauthenticated status 404, explorer HTML, NearBlocks) reveal no recipient, amount or treasury link; no public NEAR tx listed. A withdrawal to a public chain publishes recipient and amount (T5b, T5d). Browser check of the explorer page outstanding. |
| T5d | 2026-11-05 | PASS (cash-out); link via address reuse | `verification/results/T5d.md`, `T5d-*.json` | Recipient signed with its own key: EXACT_OUTPUT 0.03 USDC to Base, `SUCCESS` 23.7 s after submit, intentHash `XcC8vdrmexhL8bL6F7hLBPWNepNVYvv4fn8oh2qGu4s`, Base tx `0xc642e2c5f6cd910254a87f55b2d8c4000c8e8304d7bfdff4455b91d86a1506d0`. Net cost 0.034809 (`withdrawFee` 0.0048). Recipient confidential 0.050000 -> 0.015191; Base 0.700000 -> 0.730000. No public source checked links the withdrawal itself to the treasury or T5c; Base address and amount are public. The same Base address received public C2, whose explorer page and status name the treasury, so reuse creates a link. |
| T6 | 2026-11-05 | PASS (balances, refresh); history blocked | `verification/results/T5b-privacy.md`, `T5b-T6-partial.md`, `T6-*.json` | Session token issued to the implicit account with no `add_public_key` (`expiresIn` 900, `refreshExpiresIn` 604800). `/v0/account/balances` returned the confidential balance, `source: private`. Refresh returned `{ accessToken, expiresIn }`, 900 s, and the new token worked. `/v0/account/history` HTTP 403: `History is invite-only for now`. |
| T7 | 2026-11-05 | PASS on testnet; mainnet untested | `verification/results/T7-testnet.md`, `T7-testnet-*.json`, `T7-balances-*.json`, `T7-testnet-partial.md`, `T7-supported.json`, `T7-supported.md` | Local `createNearFacilitator` relayer, seller route at 0.01 testnet USDC, agent with full-access key: HTTP 402 then HTTP 200. Settlement tx `DmbZsDfSZH6WfBnUCKLzY8wCsybqiVujiRWFTFQ7YMUe`. Agent USDC 20.000000 -> 19.990000, seller 0 -> 0.010000; agent NEAR unchanged to the yoctoNEAR; relayer paid about 0.000339 NEAR. Agent, seller and amount are public in the tx. Mainnet reference facilitator `/supported` lists `exact` on `near:mainnet` with no asset field; no mainnet payment attempted. Failure paths not tested. |
| T8 | 2026-11-05 | Dropped: payroll natively gasless (D7) | | |
| T9 | 2026-11-05 | PARTIAL (research only) | `verification/results/T9-research.md`, `T9-research-sources.json` | Registered keys sign; named accounts must register, implicit accounts need not. Function-call keys: no source answers directly, and NEP-413 and the contract code point in different directions. Steps 1 to 3 not run. |
| T10 | 2026-11-05 | PARTIAL | `verification/results/T10-attestation.json`, `T10-attestation.md`, `T10-catalog.json`, `T10-catalog.md` | Attestation criterion met for 3 of 3 models (non-empty `model_attestations`, `request_nonce` matches); not cryptographically verified. Chat completions 0 of 3: HTTP 402 `No spending limit configured. Please contact support to set up credits.` Catalog has an `api_key` field on 9 models; values redacted, flagged for CTO. |
| S-C | 2026-11-05 | Research complete; gap open | `verification/results/S-C.md`, `S-C-signature-check.json` | Quote integrity, offline only. Signed intents name the deposit address, amount and token, but not the final recipient or destination. SDK-embedded 1Click key (not in the docs) verified 16 of 16 recorded responses and rejected a swapped deposit address, recipient, refund address, amounts. `appFees` and `confidentiality` are outside the signature. No documented unauthenticated lookup for confidential quotes (404 without partner key); no documented deposit-address derivation. A genuine quote made for an attacker still verifies, so a backend-independent contractor record is required. Compromised browser code remains unaddressed. |
| S-A | 2026-11-06 | Research and offline checks pass; real wallet untested | `verification/results/S-A.md`, `S-A-offline-checks.json` | Simulated spec-conforming `signMessage` output (base64 signature) mapped to 1Click `signedData` and reproduced 7 of 7 live signatures byte for byte, including `intents.far`. No documented multi-message prompt. Wallet Selector's README now recommends another connector (HOT Connect / NEAR Connect). MyNearWallet always passes `callbackUrl`, which by spec is hashed: treat as unsupported until tested. Named accounts need `add_public_key` (1 yoctoNEAR, full-access key, gas paid by the account). Payee records sign and verify offline; a tampered field is rejected, but an older signed version still verifies without a trusted minimum version, so rollback and revocation stay open. |
| S-A2 | 2026-11-06 | PASS: real Meteor signed `intents.near` and `intents.far`; nothing submitted | `verification/results/S-A2.md`, `S-A2-offline-checks.json` | `@hot-labs/near-connect` 0.12.0 (same project as HOT Connect). Both outputs: base64 signature, no extra fields (no `callbackUrl` or `state`), mapping passes, signatures verify with the T5 C1 method and a hand-built hash, tampering rejected. Meteor did not reject `intents.far`. Prompts show raw message JSON, not the final recipient. A first `intents.far` attempt captured no result, cause unknown. Real-wallet acceptance by 1Click and named-account payouts remain untested. |
| S-E | 2026-11-07 | PASS; cap held (0.052413 of 0.10 USDC) | `verification/results/S-E.md`, `S-E-*.json` | Expired quote: `generate-intent` returned HTTP 400 `Quote has expired` 2 s after a 10 s deadline, so nothing was signed, though the response advertised a deposit deadline 3 days later. Never-funded quote: `PENDING_DEPOSIT` 2 s and 586 min after the deadline (the 5-min check was missed by a DNS failure). Replay of a SUCCESS payout: HTTP 201 with the same `intentHash`, no second payment. |
| S-E2 | 2026-11-07 | Late submit refused; no funds moved; cap held (0 of 0.06 USDC) | `verification/results/S-E2.md`, `S-E2-*.json` | Payload signed 58 s before a 60 s quote deadline, submitted 5.8 s after it: HTTP 400 `Quote has expired`. The signed message carried its own deadline 3 days later (the quote's `deadline`). Status `PENDING_DEPOSIT` for 10 min, balances unchanged. Direct submission to `intents.near`, bypassing 1Click, not tested. |