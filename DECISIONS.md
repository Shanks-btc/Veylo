# DECISIONS.md — Veylo Architecture Decision Record

Living record of established decisions, open risks and status. Changes to a locked decision require an explicit new entry; never silently overwritten.

Last updated: 2026-11-06 (Phase 3 complete; build started)

---

## Product

**Name:** Veylo (pending domain / X handle / trademark check by founder)

**Thesis (locked):**
Private borderless payroll on NEAR: one confidential treasury pays your global team: gasless for everyone, and payroll that isn't publicly linked to your company. *(Narrowed by L46: agents and HTTP 402 removed; NEAR-only payouts.)*

> The original ending "no salary ever made public" is false: a payout delivered to a public chain exposes the recipient address and amount (T5b, T5d). An earlier proposed ending, "no salary ever traceable to your company", is also an overclaim: address reuse creates a public link to the treasury (T5d); timing/amount analysis was never attempted; 1Click and private-shard operators can see details. Absolute claims ("never", "every") are not supported by the evidence.
>
> **Evidence-supported claim for README/privacy doc:** "No public source we checked links a confidential payout to your company, provided the payout address has never received a public payment from you."
>
> **Chosen ending (2026-11-05):** "payroll that isn't publicly linked to your company". The condition above must appear wherever the headline does (product rule 11).

**Supporting claim (evidence-backed, T5c):** For contractors who choose private receipt, the salary never touches a public chain while it stays in their confidential balance.

**Positioning rule:** Payroll leads in every README, demo and pitch. Agent payments are the second act.

**Tracks:** Real-World Money (primary), Agent Economy, Privacy.

---

## Locked decisions

| ID | Decision | Date | Notes |
|---|---|---|---|
| L1 | Network: **NEAR mainnet** for payouts, x402 demo and everything judges see. **Amended:** testnet allowed for experiments that don't touch Intents (x402 protocol test). | 2026-11-05 | NEAR Intents has no testnet. |
| L2 | Roles: CTO/architect (Claude, chat) designs and reviews; Claude Code (VS Code) implements; Kelvin executes, reviews `git status`, handles all commits and pushes. No co-author tags. | 2026-11-05 | |
| L3 | Engineering charter: no fake functionality, no unverified endpoints, no misleading privacy claims, no implementation without acceptance criteria. Every capability labeled **implemented / tested / simulated / planned**. | 2026-11-05 | |
| L4 | Phase gates: no product code until Phase 3 (architecture) and Phase 4 (design system) are approved. | 2026-11-05 | |
| L5 | Repo started with verification workspace only. Product structure decided in Phase 3. `verification/` dependencies and lockfile never carried into product code without review. | 2026-11-05 | 57 audit issues in verification deps. |
| L6 | AI agents (a) prepare and propose pay runs, (b) pay external APIs via x402 from capped budgets. **Agents never hold a key registered for the treasury and never release payroll funds.** | 2026-11-05 | Enforced by D3. |
| L7 | Built for verifiability (AI screening). See section below. | 2026-11-05 | |
| L8 | Claude Code may edit only the §6 results log in VERIFICATION.md. **Amended 2026-11-06:** Claude Code may write DECISIONS.md and ARCHITECTURE.md **only with verbatim content supplied by the CTO in a prompt**; it never makes its own changes to them. | 2026-11-05, amended 2026-11-06 | |
| L9 | Fee basis for EXACT_OUTPUT quotes: `minAmountIn`, with `amountIn` recorded beside it. | 2026-11-05 | |
| L10 | **Treasury lives inside NEAR Intents** and pays out via signed intents (NEP-413). | 2026-11-05 | NEAR-origin ORIGIN_CHAIN quotes fail; Intents path verified live. |
| L11 | **Cost discipline:** every live spend preceded by a dry quote; each step has a hard cap; report remaining balance after each step; prefer internal Intents transfers or testnet when they prove the same thing; never repeat a paid test for cleaner logs. | 2026-11-05 | Founder low on funds. |
| L12 | **Never hardcode the intents salt.** Read it from the correct verifier contract at runtime. | 2026-11-05, corrected 2026-11-06 | Salts are per chain: `252812b3` (intents.near), `e110f317` (intents.far). A confidential nonce needs the confidential chain's salt. |
| L13 | **ARCHITECTURE.md v1.0 approved** (2026-11-06). Changes require a new entry here. | 2026-11-06 | |
| L14 | Phase 3 founder decisions: Vercel (web, static) + Railway (API/worker, Postgres); TypeScript 5.x exact pin; thin in-house 1Click client (no intents SDK); x402 = request reference facilitator key, self-host fallback; private receipt requires contractor NEAR wallet (MVP); tests on embedded Postgres (PGlite). | 2026-11-06 | |
| L15 | **L4 amended:** non-UI slices (domain logic, data layer, API) may start once ARCHITECTURE.md is approved; UI slices wait for the approved Phase 4 design system. | 2026-11-06 | |
| L16 | **T-2 defense adopted:** browser gate A + B + C before every payout signature (1Click quote signature, owner-signed payee registry with anti-rollback head + high-water mark + expiry, amount tolerance), fail closed; web hosted separately from API. | 2026-11-06 | S-C, S-A, S-A2 |
| L17 | **File handoff rule:** the founder never edits or replaces files manually. The CTO supplies full file contents (or exact edits) inside Claude Code prompts; Claude Code writes them and confirms. | 2026-11-06 | Founder request |
| L18 | **Payout state machine amended (slice 1 review):** RECONCILED is a field (`reconciled_at`), not a status; terminal = SUCCESS, REFUNDED, FAILED, EXPIRED; added exits PLANNED→FAILED, QUOTED→FAILED, SIGNED→FAILED, SIGNED→EXPIRED and direct SUBMITTED→terminal (record only observed states); FAILED requires `failure_reason`; retry from FAILED/EXPIRED after status check, from REFUNDED only after reconciliation. | 2026-11-06 | Slice 1 findings |
| L19 | **Runtime: Node 24 LTS + pnpm 11** (replaces Node 20, end-of-life April 2026). | 2026-11-06 | CTO correction |
| L20 | **Amount columns:** USDC ledger amounts `bigint`; non-USDC asset amounts `numeric(78,0)` (18-decimal tokens overflow bigint above ~9.22 tokens). Tenant integrity via composite FKs including `org_id`. | 2026-11-06 | Slice 1 findings |
| L21 | **Tenant and history integrity (slice 1.2):** `pay_runs.approved_by` references `memberships(org_id, user_id)`; `payee_registry_heads` fully append-only (no UPDATE/DELETE/TRUNCATE); `payee_approvals` immutable except one-time `revoked_at`. | 2026-11-06 | Slice 1.1 findings |
| L22 | **Memberships are never deleted:** status `active`/`removed` with `removed_at`; removed members are non-members everywhere; last active owner cannot be removed or demoted. | 2026-11-06 | Slice 1.2 side effect |
| L23 | **Auth design (slice 2):** Sign in with NEAR via NEP-413 over a server-issued plain-text challenge (5-min expiry, single-use, atomic); key must derive the implicit account or be a FullAccess key of the named account (NEAR RPC); server-side sessions (token hash only) in an httpOnly Secure SameSite=Lax cookie. **Production requires web and API on the same site** (e.g. app.<domain> and api.<domain>) so the cookie works; founder to choose the domain. Cross-tenant access returns 404. | 2026-11-06 | |
| L24 | **Slice 2 rulings:** `audit_log.org_id` nullable only for `auth.*` actions; approver must be an active owner at approval time (trigger + service check); implicit accounts that exist on-chain require a FullAccess key via RPC (derivation alone only for never-funded accounts); `TRUST_PROXY_HOPS` default 0, verified at deploy. Real-wallet sign-in test deferred to the first UI slice; production must run built JS, not tsx (deploy slice). | 2026-11-06 | Slice 2 findings |
| L25 | **MVP payout routes:** Direct to wallet = USDC on Base, Arbitrum, Solana; Private receipt = USDC confidential balance on NEAR. Tron unsupported until tested. Destination addresses are never edited (new row; old one superseded). Destinations not payable until owner-approved (slice 3b). | 2026-11-06 | T1, T2, T5 evidence |
| L26 | **Deploy rule:** with `TRUST_PROXY_HOPS` > 0, the API must be reachable only through the host's proxy (no direct public access), verified at deploy. | 2026-11-06 | Slice 2.1 finding |
| L27 | **Destination states:** `rejected` (address refused, final) vs `route_unavailable` (route-level, retryable) vs `check_failed` (network, retryable); candidates never displace an active destination. Destinations record `entered_by` and `contractor_confirmed_at`; contractor re-confirmation arrives with the contractor portal (slice 9). | 2026-11-06 | Slice 3 findings |
| L28 | **Payee approvals and registry heads must be signed by the treasury account itself** (verified via NEAR RPC), not by any database owner: the database is untrusted under T-2. Other owners may manage contractors but cannot approve payees. | 2026-11-06 | CTO security review |
| L29 | **Registry set hash v1 (locked, signed bytes):** SHA-256 over the sorted lowercase hex approval record hashes joined by `\n`, no trailing newline; empty set = SHA-256(""). Changes require schema v2. Set rules: re-approval drops its own earlier entry; expired approvals stay until the next head but are never payable; **a contractor with a superseded-but-signed approval is blocked from all payouts until a new head removes it** (UI must prompt the owner to sign it; residual risk disclosed). | 2026-11-06 | Slice 3b rulings |
| L30 | **Treasury guards:** the treasury account's membership cannot be removed or demoted; treasury rotation is a later feature. **No generic live-quote method exists:** only purpose-specific quotes (funding → own treasury; shield → own treasury; payouts from slice 5). 1Click session tokens are encrypted at rest (XChaCha20-Poly1305 envelope, AAD-bound) and never logged or returned. | 2026-11-06 | Slice 4 design |
| L31 | **Key separation:** `SESSION_ENCRYPTION_KEY` (API; 1Click session tokens, read-only data) and `AGENT_KEY_MASTER_KEY` (worker only; agent keys, funds). A compromised API can read confidential balances but cannot decrypt agent keys. | 2026-11-07 | Slice 4 ruling |
| L32 | **Slice 4 rulings:** funding origins labelled `live` vs `dry_quote_only` (only BSC USDT live so far); per-org and per-user rate limits on live-quote and signing-request routes; an uncertain submit is closed only after its deadline passes **and** a status check shows no record (`expired_unsubmitted`), built generically in slice 5. | 2026-11-07 | Slice 4 rulings |
| L33 | **S-E findings:** `generate-intent` rejects after the quote deadline ("Quote has expired"); a duplicate submit of the same signed payload returns 201 with the same intentHash and no second payment (ledger treats a repeated intentHash as already submitted); never-funded quotes stay PENDING_DEPOSIT indefinitely (status alone cannot detect a dead quote). The signed intent message carries its own deadline (~3 days beyond the requested one observed): uncertain-submit closure (L32) uses **the signed message's deadline**, and signed-but-unsubmitted payloads are treated as **bearer authorizations** (never logged, encrypted at rest, owner-only) until that deadline. Whether a signed payload executes after the quote deadline: see S-E2. | 2026-11-07 | S-E |
| L34 | **S-E2 findings and payout deadline policy:** through 1Click, the **requested** quote deadline governs both generate-intent and submit-intent (late submit refused, no funds moved), even though the signed message's own deadline is ~3 days later. Direct submission to intents.near (bypassing 1Click) is untested and may be possible until the message deadline. Rules: payout quote deadlines short (default 15 min, `PAYOUT_QUOTE_DEADLINE_MINUTES`), owner signs right before submit; an uncertain submit is resolved by **resubmitting the identical signed payload** (safe per S-E) before the deadline, never by re-signing without a status check; amounts in signed, unsettled payloads are **encumbered** in the treasury's available balance until the signed message's deadline passes. Future spike S-L: owner-signed nonce invalidation on intents.near to kill dangling payloads early. | 2026-11-07 | S-E2 |
| L35 | **Slice 5a rulings:** on live quotes 1Click signs its own (3-day) deadline, not our requested one; 1Click still enforces its stored requested deadline at submit, so the browser gate computes its own signing bound from the quote's **signed timestamp + PAYOUT_QUOTE_DEADLINE_MINUTES** and never trusts a served deadline. Funds check uses the sum of `amountIn` (amount actually signed); fees reported on the L9 basis. Simulated runs skip the funds check. A failed fee preview blocks approval (retry via review). A network failure during quoting records FAILED (`unknown`) and the item is re-quoted. | 2026-11-07 | Slice 5a findings |
| L36 | **Slice 5b rulings:** two worker processes, `worker:settlement` (session key) and `worker:agents` (agent key, slice 8), neither loading the other's key; reconciliation applies to every terminal outcome that reached 1Click (SUCCESS, REFUNDED, FAILED settlement_failed), never EXPIRED or submit_rejected; confidential token prefix pinned and fail-closed (`unrecognized_confidential_token`); double encumbrance on retry accepted and explained in UI; no item retry while a run is Settling (MVP). | 2026-11-07 | Slice 5b findings |
| L37 | **Slice 6 rulings and deploy readiness:** verify shows one evidence summary line (details in verify-report.md); RPC errors/timeouts/rate limits are SKIPPED (network), FAIL only on definitive contradiction; archival NEAR RPC for re-checks; explorer domains confirmed from official docs; CSV uses full chain names; ledger uses keyset pagination. Production runs built JS only, with /health (liveness) and /ready (database + migrations), graceful shutdown, and boot smoke tests; DEPLOY.md is the runbook. | 2026-11-07 | Slice 6 findings |
| L38 | **Slice 6.1 rulings:** Solana explorer links use explorer.solana.com only after an official source is fetched and cited; otherwise they stay off. Client IP is logged only when LOG_CLIENT_IP=true (default false), used during the L26 proxy check and turned off after. Each process loads its own config schema; the settlement worker no longer requires AUTH_RECIPIENT, WEB_ORIGIN or PORT; per L36 it keeps SESSION_ENCRYPTION_KEY to decrypt payloads it resubmits, and it never holds AGENT_KEY_MASTER_KEY. Both workers refuse to start while migrations are pending or unreadable (exit 1). Railway settings in DEPLOY.md cite Railway docs or are marked unverified. | 2026-11-07 | Slice 6.1 findings |
| L39 | **Slice 6.2 rulings:** Solana explorer domain is sourced from the official explorer repository's About link, and the /tx/<signature> format must be confirmed from that repository's source tree before links are enabled. Workers that cannot reach the database exit 1 with reason database_unreachable. migrate loads its config through the config package (DATABASE_URL only). | 2026-11-07 | Slice 6.2 findings |
| L40 | Claude Code does not stop to ask questions; it picks the most secure option consistent with the records, implements it, and lists it under 'Decisions I made' in its report. It stops only for irreversible actions, mainnet transactions or spending, changes to signed bytes, or deleting data or files outside the slice. | 2026-11-10 | Founder instruction |
| L41 | **Slice W1:** web foundation built logic-first with no visual design; browser gates A, B, B2 and C fail closed and are the only authority for enabling signing; the visual design is applied in a later slice from the founder's UI reference. | 2026-11-10 | Phase 4 start |
| L42 | Brand palette locked: ink #0A0E1F, accent indigo #5B6CFF, private amber #F5B94A (only for private), green success, red errors. Type: Inter Tight, Instrument Serif (quote band only), IBM Plex Mono. Landing page follows design/reference/landing.html. Photos are Unsplash-licensed with links in design/images/LICENSES.md. The logo is a placeholder until a real one is supplied. | 2026-11-10 | Founder design approval |
| L43 | **Slice W2 findings:** one wallet signature for a whole pay run is not supported or provable now. 1Click documents one quote, one deposit address and one signed intent each (D2, T5 batch; S-H untested), so the copy was changed to "Review once. Approve each payout in your wallet." and the button to "Approve payouts in wallet". Only Inter Tight is preloaded; IBM Plex Mono and Instrument Serif load after first paint. | 2026-11-10 | Slice W2 findings |
| L44 | Wallet signing runs on a separate wallet origin with its own CSP and no API access; app and bridge talk only by origin-checked postMessage; the app verifies every signature, key and account itself. The app origin's strict CSP is unchanged. | 2026-11-10 | Slice W1 findings |
| L45 | Gate B2 checks has_public_key on the verifier named in the payload (intents.near or intents.far only). Gate C allows the signed amount to exceed the payout by at most max(1 USDC, 1%). | 2026-11-10 | Slice W1 findings |
| L46 | Scope: NEAR-only private borderless payroll. Agents and HTTP 402 removed (slices 7 and 8 removed, code kept and disabled). Payout routes: private (confidential USDC on NEAR) and direct (public USDC to a NEAR account, pending spike S-N). Base, Arbitrum and Solana kept in code, disabled. Hackathon tracks: Real-World Money (primary), Privacy (secondary). | 2026-11-10 | Founder decision |
| L47 | Mobile hero has no photo; headline is LCP. Measured in slice W6 (Lighthouse 13.5.0, Chrome 157, mobile emulation and throttling, landing page, median of five runs): Performance 92 (runs 90, 90, 92, 93, 95), Accessibility 100, SEO 100, Best practices 96, LCP 2.20 s (runs 1.75 to 2.90 s), CLS 0, TBT 271 ms, FCP 0.92 s. The bar is unchanged: Performance >= 90 (landing >= 85 allowed by the W3 brief), LCP < 2.5 s, CLS < 0.05, all met at the median. The W6 fix for LCP: Next's script tags are held back until after the load event by one inline loader pinned in the CSP (hydration still happens, after first paint), and the scroll-reveal logic moved out of every section into one controller, so the headline paints without waiting for React. One caveat on how it is measured: with Chrome 157 and Lighthouse 13.5.0 the page's `Cross-Origin-Opener-Policy: same-origin-allow-popups` header (kept; wallet pop-ups need it) makes Lighthouse fail with NO_NAVSTART, so the measuring run serves the build without that one header (SERVE_WITHOUT=Cross-Origin-Opener-Policy). The header does not change load performance. | 2026-11-13 | Slice W2.1 findings, updated in W6 |
| L48 | Veylo leads with private payroll. README written for bookkeepers and AI screeners (do X → see Y). Compared factually with NEAR Business; no first/only/unique claims. Hosted demo stays up until at least 2026-11-25. | 2026-11-12 | Founder decision |
| L49 | 0xAf78…2C8C is not the founder's personal wallet; kept in fixtures and evidence. | 2026-11-12 | Founder decision |
| L50 | Differentiation: live privacy proof, verify-payout page, tamper demo, pnpm demo, contractor CSV import. Claims limited to what is checked live or recorded in docs/EVIDENCE.md. | 2026-11-12 | Founder decision |
| L51 | Recurring payroll (D1): the worker prepares scheduled drafts three days before payday, in the organisation's time zone, and marks them Ready for review, but never quotes, signs or submits. Schedules count dates, not instants; a unique (organisation, payday) index makes preparing idempotent. The reminder email is stubbed behind a disabled flag. | 2026-11-12 | Founder decision |
| L52 | Roles (D2): owner, preparer, accountant (and viewer), enforced by the API. A preparer prepares drafts and contractors and cannot approve addresses or request approval signatures; an accountant reads the ledger, payslips, statements, CSV and audit log and sees names and routes only. A route without a role test case fails the suite. | 2026-11-12 | Founder decision |
| L53 | Contractor portal (D3): single-use expiring invite, wallet sign-in through the bridge, a contractor sees only their own data. An address change waits 24 hours and only the owner applies it; the old approval keeps working until then and the owner sees a warning. Live cash-out is a spike that refuses to run without an explicit founder approval variable. | 2026-11-12 | Founder decision |
| L54 | Payslip PDFs and period statements (D4) are built in the browser from the ledger, with no new external host and the CSP unchanged. A statement total equals the ledger total, and every PDF carries the payout's verify link. | 2026-11-12 | Founder decision |
| L55 | Pay-run safety extras (D5): warn on an amount that deviates by more than REVIEW_AMOUNT_DEVIATION_PERCENT and on a first payout to an address; block approval of an address changed under 24 hours ago. The owner ticks "I've checked this" for each warned item before Approve enables, and the API enforces the tick. | 2026-11-12 | Founder decision |
| L56 | Currencies. Treasury holds USDC; funding in USDC or NEAR (NEAR pending S-F2). Payouts in USDC (private or direct) or NEAR (direct unless confidential NEAR is documented and proven; pending S-NR), USD-denominated. Local currencies are display-only estimates; bank cash-out via licensed partners is post-hackathon. A NEAR payout is quoted at payout time as EXACT_OUTPUT (the contractor receives the promised value; the treasury carries the swap fee), and gate C bounds the spend between the approved USD and USD plus max(1 USDC, 1%). The confidential NEAR payout is not documented in the docs checked, so NEAR is offered as direct only. Local-currency rates come from one public source (open.er-api.com), cached at most an hour, never used in any money calculation (a test reads the source of every money path). | 2026-11-12 | Founder decision |
| L57 | All 28 pages are complete with empty, loading, error and success states; a crawler fails on any dead link. Public 7, owner app 17, contractor portal 4, plus the account screens; a browser check proves the skeleton, the plain-words error with a way to retry, and the designed empty state of every data page. | 2026-11-12 | Founder decision |
| L58 | Veylo supports every NEAR wallet in the near-connect manifest that passes NEP-413 signMessage and the bridge rules; executors pinned by SHA-256; exclusions in docs/WALLETS.md. Seven of fourteen wallets are enabled; each has its own bridge page and policy, and the app verifies every signature the same way for all of them. Only Meteor has been exercised with a real wallet (spike S-A2); the others are read and fixture-tested. | 2026-11-12 | Founder decision |
| L59 | Every page is responsive from 320 px to 1920 px and phone landscape, enforced by Playwright overflow, target-size and axe checks. Widths 320, 360, 375, 390, 414, 768, 834, 1024, 1280, 1440, 1920 and 844 x 390, plus five emulated devices; no sideways scroll, no element off the screen, no clipped text, no overlapping controls, 44 px touch targets, stacked cards, one-column forms, sticky actions, sheets, a bottom bar and safe-area insets; axe on every page at 390 and 1440 px. | 2026-11-12 | Founder decision |
| L60 | Users can create a non-custodial embedded wallet at sign-up: the key is generated and kept encrypted in the wallet bridge origin (passkey via WebAuthn PRF, or password with a strong KDF), with a mandatory recovery phrase; Veylo's server never sees it. External wallets remain supported. The account is the implicit account of an ed25519 key from a BIP-39 phrase (SLIP-10, m/44'/397'/0'); the vault is AES-256-GCM under a passkey PRF key or an Argon2id key; the wallet page has connect-src none. NEAR's own hosted onboarding was not used: its mainnet use needs approved credentials and documents no NEP-413 signing. Pending S-EW on mainnet. | 2026-11-12 | Founder decision |
| L61 | Ecosystem verdicts (docs/ECOSYSTEM.md). NEAR Business as the Veylo treasury: not feasible today (a contract account has no key for NEP-413; no documented third-party path). A Trezu or SputnikDAO multisig authorising Intents payouts: not safely (the only route registers one key that then signs alone). Several approvers for a pay run: feasible as a browser-checked approval workflow with a single treasury signer; roadmap, not built. No integration is mandatory (Q-011). | 2026-11-12 | Founder decision |
| L62 | Email accounts and USDC-first funding. Email and password (Argon2id on the server), a confirmation link, password reset and contractor invitations; the email account is for sign-in and notices and has no signing power. The wallet key stays separate and non-custodial: the email password never unlocks it and a reset never restores a wallet (a test fails if one secret reaches both). Funding order: USDC on NEAR (address and QR code), USDC from another network through 1Click, then NEAR converted to USDC; the treasury is held in USDC so payroll doesn't change with crypto prices. Email delivery is not built: no provider is chosen (docs/DEPLOY.md section 16). | 2026-11-12 | Founder decision |
| L63 | USDT funding. "Fund with USDT on NEAR (converted to USDC)" is option 2 on the Fund screen and uses the NEAR-funding flow (EXACT_INPUT, gate F before any deposit instruction, rate, fee and USDC received). usdt.tether-token.near is listed by 1Click (T1, 2026-11-05); EURC is not listed (only EURe on Gnosis). Coming soon until spike S-FT passes. | 2026-11-12 | Founder decision |

---

## Phase 2 decisions (from evidence)

| ID | Decision | Evidence |
|---|---|---|
| **D1** | **Privacy architecture:** treasury holds funds in its **confidential** Intents balance. Two contractor payout modes: **Private receipt** (pay into the contractor's confidential balance; nothing public) and **Direct to wallet** (deliver to chosen chain/token; recipient address + amount public on destination chain, no employer link). Treasury top-ups (shield) are public in total only. | T3, T5b, T5c, T5d |
| **D2** | **Payroll execution:** each payout = its own quote + its own signed intent from the treasury's Intents balance. A pay run of N contractors = N quotes, N signatures, settling independently in parallel. | T5 (C2, batch) |
| **D3** | **Signing authority:** only the **owner's wallet** signs payout intents. The agent holds no treasury key; it only prepares runs. Basis: docs state every key registered to an account on intents.near can sign intents for it; source reading (commit 32cd1f9, not compared with the deployed contract) suggests function-call key limits are not checked. **Status: inferred, untested.** The design is safe either way: it never relies on key restrictions. | T9 research (docs + source), T5 |
| **D4** | **Agent wallet model:** each AI agent has its **own dedicated NEAR account holding only its budget** (cap = balance), topped up by the treasury per policy. Agent x402 spend is **public** (agent, seller, amount). Candidate mitigation (untested): fund agent accounts from the treasury's confidential balance so agent spend isn't traceable to the company. | T7 (testnet) |
| **D5** | **AI model and attestation:** candidate TEE-private models `z-ai/glm-5.3-flash`, `Qwen/Qwen3.6-35B-A3B-FP8`, `Qwen/Qwen3.8-27B`; all return model-level attestation responses whose `request_nonce` matches ours. **No quote has been cryptographically verified yet** (status: partial); verification via NEAR AI's official verifier is part of `npm run verify` and is required before any "provably private AI" claim. Final model choice pending completions (needs NEAR AI credits). | T10 (attestation, partial) |
| **D6** | **Fees (corrected 2026-11-06):** per-payout delivery fees **vary over time, by route and by confidentiality** (observed Base 0.0024 public / 0.0048 confidential; Arbitrum 0.0053 then 0.0106 two days later; Solana ~0.24), plus ~2 bps. Internal confidential transfers and deposits into Intents: no delivery fee. **Never hardcode a fee:** always show a fresh quote's fee with its timestamp; suggest low-fee routes. | T2 diag, T5, T5b, T5c, T5d, slice 3 live quotes |
| **D7** | **No custom gas relayer for payroll.** The treasury needed no NEAR for any payout; gas is paid by the settlement infrastructure (the specific payer is not identified in our evidence). x402 gas is paid by the facilitator relayer (~0.00034 NEAR per payment, one sample). | T5, T7 |

---

## Product rules derived from evidence

1. **Validate contractor addresses per chain before quoting, and handle 1Click recipient rejection anyway.** 1Click rejected correctly formatted addresses (the Solana system program, the EVM 0x…dEaD burn address) as "recipient is not valid", so format checks alone won't catch everything.
2. **Payment ledger key:** `depositAddress` + `correlationId`; store our submitted `intentHash`, settlement intent hashes, NEAR tx hashes and destination tx hash.
3. **Never re-sign a payout without checking its status first** (idempotency; deposit addresses are single-use; retries get a fresh quote).
4. **Design for partial failure:** per-payout state within each pay run; the run can be partially successful. (Design assumption: no payout failure has been observed yet; failure paths untested.)
5. **Reconcile from balances plus a delayed status re-check:** `refundedAmount` lags right after `SUCCESS`. **Confirmed:** the Base batch payout showed `refundedAmount: 0` at first SUCCESS (updatedAt 15:33:53) and `0.001035` on re-read (updatedAt 15:34:02), matching balances.
6. **Our own backend ledger is the source of truth for payout history** (1Click `/v0/account/history` is invite-only).
7. **Session tokens:** access 15 min, refresh 7 days (refresh returns no new refresh token; re-sign after expiry). Always treated as secrets.
8. **Address hygiene:** track addresses that received a *public* payout from a company; warn and recommend a fresh address if a contractor cashes out privately to one. One payout mode per contractor by default.
9. **Cash-out guidance:** explain that withdrawing a full salary in one go reveals roughly that figure; make partial withdrawals easy.
10. **Honest trust disclosure:** 1Click and the private-shard operators can see confidential transaction details; privacy is from public observers.
11. **Headline + condition rule:** wherever the thesis headline appears, the evidence-backed condition appears with it.
12. **Human-readable summary before every wallet prompt** (wallets show raw JSON; S-A2).
13. **Persisted pending state for every signing request;** lost wallet responses resolved by status check, never blind re-signing.
14. **Deduplicate wallet connector accounts** (NEAR Connect returned duplicates).
15. **Supported wallets = tested wallets:** Meteor / Chrome / desktop for MVP payouts.

---

## L7 — Verifiability requirements

Projects are first screened by Claude Code & Codex, which check that the project runs and does what the README says. We win by being easy to verify, never by persuading the screener.

**Prohibited:** hidden instructions, "notes to AI judges", prompt injection, or any persuasion aimed at screening agents.

**Required:**
1. One-command verification without funds: `npm run verify` runs tests, dry 1Click quotes, a live NEAR AI attestation check (with cryptographic verification), and re-checks recorded mainnet transactions via public RPC.
2. Dry-run mode as a core product feature, clearly labeled.
3. Claim-to-evidence table in README.
4. `EVIDENCE.md` with every real mainnet payout, re-checked by `verify`.
5. Every on-chain action logged with its tx hash and surfaced in the audit trail.
6. Orientation docs: `AGENTS.md` / `CLAUDE.md`, `ARCHITECTURE.md`, `SECURITY.md`, privacy model doc (the honest stage table from D1).
7. Reproducible setup (pinned Node, lockfile, `.env.example`, ≤5 steps).
8. README "do X → see Y" steps, no marketing.
9. Green CI running `verify`.
10. Hosted read-only demo company browsable without a wallet.
11. Disclose pre-existing code; list libraries; LICENSE; no secrets in git history.

---

## Verified constants

- USDC on NEAR (1Click asset ID): `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
- Circle testnet USDC on NEAR: `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`
- Confidential verifier contract seen in payloads: `intents.far`; public: `intents.near`
- Live intents salt (2026-11-05): `252812b3` (read at runtime; never hardcode)

---

## Phase 2 results summary

| Test | Result |
|---|---|
| T1 token catalog | PASS |
| T2 dry quotes | NEAR-origin ORIGIN_CHAIN fails; Intents-origin passes |
| T3 confidential access | Embedded path PASS (live); foreign-to-foreign `confidentiality` dry only, Arbitrum origin only |
| T4 origin-chain payout from NEAR | Dropped (not on architecture path) |
| T5 payout + batch from Intents balance | PASS (mainnet) |
| T5b confidential payout | PASS (mainnet) |
| T5c private receipt | PASS (mainnet) |
| T5d contractor cash-out | PASS (mainnet) |
| T6 User-Session balances + refresh | PASS; history invite-only |
| T7 x402 agent payment | PASS on testnet; mainnet untested (facilitator key or own relayer) |
| T8 relayer | Dropped (D7) |
| T9 access-key roles | Inferred from docs + source, untested on-chain (D3) |
| T10 TEE attestation | PARTIAL: nonce-matched attestation responses for 3 models, not cryptographically verified; completions blocked on credits |

---

## Open items / risks

1. **NEAR AI credits** needed for completions (D5 final choice).
2. **x402 on mainnet:** reference facilitator key to be requested; fallback self-host (L14). Untested on mainnet (S-G).
3. **N signatures per pay run:** one wallet prompt per payout in MVP (no documented multi-message API, S-A). Single-signature batches parked as S-H.
4. **Agent spend privacy:** confidential-funded agent accounts untested.
5. **Exposed `providerConfig.api_key` fields** in NEAR AI public catalog: responsible disclosure to NEAR AI pending.
6. **1Click support:** NEAR-origin ORIGIN_CHAIN failure and `/v0/account/history` invite **not yet sent** (see action items).
7. Timing/amount analysis of confidential flows not attempted; privacy claims limited to the sources checked.

---

## Founder action items

- [x] 1Click partner JWT
- [x] NEAR AI Cloud API key
- [ ] NEAR AI credits / spending limit (or hackathon credits via Discord)
- [x] Thesis ending chosen: "payroll that isn't publicly linked to your company"
- [ ] Request FastNEAR reference x402 facilitator key (mainnet)
- [ ] UI visual references for the design system
- [ ] Back up `verification/.env` (password manager)
- [ ] Send support/disclosure emails (1Click NEAR-origin + history invite; NEAR AI api_key disclosure)
- [ ] Name checks and **domain choice** for "Veylo" (needed for same-site web/API cookies, L23)

---

## Phase status

| Phase | Status |
|---|---|
| 1. Product understanding | ✅ Complete |
| 2. Research and feasibility | ✅ Complete (T10 completions pending credits) |
| 3. Architecture and data model | ✅ Complete: ARCHITECTURE.md v1.0 approved 2026-11-06 (spikes S-A, S-A2, S-C done) |
| 4. Design system and UI/UX | ⏳ Awaiting founder's visual references |
| 5. Build | ▶ Slice W6 complete (all 28 pages, all capable wallets, USDC/NEAR funding and payouts, local-currency display, full responsiveness); next: founder LICENSES.md, live wallet tests, spike approvals (S-N, S-F2, S-NR, cash-out), deploy, demo, submit |
| 6–9 | ⏳ |

## Treasury funds (end of Phase 2)

| Location | USDC |
|---|---|
| Treasury public Intents balance | 0.987557 |
| Treasury confidential balance | 0.145177 |
| Recipient (dev) confidential balance | 0.015191 |
| Dev EVM address on Base | 0.730000 |
| Dev EVM address on Arbitrum | 0.100000 |
