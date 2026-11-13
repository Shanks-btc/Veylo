# Veylo

**Private payroll on NEAR: salaries are paid through NEAR Confidential Intents, so they aren't publicly linked to your company. Gasless for everyone.**

Private means no public source we checked links a confidential payout to the company, provided the payout address has never received a public payment from it.

This README is written for a bookkeeper or finance lead, and for anyone reading it quickly (a judge, a screener, a script). It says what Veylo does, how to try it in two minutes, and what has been proven on NEAR mainnet. A short developer section is at the end.

## Judge quickstart

**Hosted demo:** `<hosted-demo-url>` (placeholder: set when deployed, see [docs/DEPLOY.md](docs/DEPLOY.md) section 14). It runs on made-up people and amounts, with a real recorded NEAR Intents quote.

| #   | Do                                                                                     | See                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Open the demo link.                                                                    | The landing page: "Pay your team anywhere. Keep payroll private."                                                                                                                                                                          |
| 2   | Click **Open app**, then **Use a wallet instead**, then **Use the demo wallet**.       | A real sign-in message is checked and signed by the demo wallet. You land on the treasury home with a "Demo data" banner.                                                                                                                  |
| 3   | Open **Pay runs**, then the 2026-11 run, then **Check before signing**.                | Five checks turn to PASS (quote signature, payee list, key, amount, time left). **Approve payouts in wallet** unlocks.                                                                                                                     |
| 4   | Click **Redirect Kwame's payout to an attacker**.                                      | Four checks turn to FAIL (quote signature, payee list, amount, time left), in plain words ("The payee list your server sent isn't the one your treasury wallet signed"). Approve stays locked. **Undo the attack** brings the passes back. |
| 5   | Open **Privacy**.                                                                      | The same kind of payout seen two ways, read live from NEAR mainnet: the direct one can be followed from treasury to recipient; for the private one, no public transaction names the treasury.                                              |
| 6   | Open **Ledger**, then **Verify** on a payout, and download a payslip or statement PDF. | The verify page re-reads the payout's NEAR transactions and checks the amount and recipient. The PDF carries the same verify link.                                                                                                         |

Locally, with no keys and no money:

```
pnpm i && pnpm demo
```

It runs the whole story and prints 19 numbered checks in under a minute: fund the treasury, add a contractor, approve their address, review the pay run, browser checks pass, a redirected payout is refused, approve and settle, payslip and CSV, privacy proof, recurring payroll, roles, CSV import, the contractor portal, an email account, funding (USDC on NEAR first, and the quote's signature checked), local-currency estimates, the contractor's private balance, a payout in NEAR, and the Veylo wallet. It exits non-zero if any check fails.

## What Veylo does

Veylo pays your contractors in USDC from one confidential treasury on NEAR, and each person chooses to be paid privately or directly. Nobody, including you, needs a gas token. Every payout is checked in your browser before you approve it, and every payout gets a payslip and a line in your CSV export.

Sign up and get a wallet in seconds; no app to install. Only you hold the key.

The shortest path to a first payment: sign up with your email, create your wallet with a passkey, confirm your recovery phrase, fund the treasury with USDC on NEAR, add a contractor, and pay them. Your treasury is held in USDC so payroll doesn't change with crypto prices.

## Try it

**(a) The hosted demo** (no install): follow the six rows in the table above.

**(b) On your computer, with demo data:**

1. `pnpm install`
2. `pnpm dev:web`. Open http://localhost:3000 for the landing page and http://localhost:3000/app for the app. Every page shows a "Demo data" banner, and nothing is saved, signed or sent.
3. Click **Use a wallet instead**, then **Use the demo wallet**. Expect to land on the treasury home. The demo wallet signs a real sign-in message.
4. **Contractors**: expect Kwame (payable) and Ada (waiting for the treasury wallet's approval).
5. **Pay runs** then **2026-11**: expect one payout ready and one held back, with its reason.
6. Click **Check before signing**. Expect five PASS rows and **Approve payouts in wallet** enabled.
7. **The tamper test:** click **Redirect Kwame's payout to an attacker**. Expect four FAIL rows (the account-key row still passes) and Approve disabled. Click **Undo the attack** and expect five PASS rows again.
8. Click **Approve payouts in wallet**. Expect the pay run status screen.
9. **The privacy proof:** open **Privacy**. Expect two columns, each read from NEAR mainnet when the page loads, with a "checked at" time. If NEAR can't be reached, expect "Couldn't check right now", never a cached answer.
10. **Ledger**, then **Verify** next to a payout. Expect a list of checks for a direct payout, or the recorded status for a private one.

**(c) With a real wallet, still on your computer:** start Postgres and migrate it, then run `pnpm dev:wallet` and open http://localhost:3000. The steps are in [docs/DEPLOY.md](docs/DEPLOY.md) section 13.

## Built on NEAR

- **NEAR Intents is the treasury.** The treasury holds its USDC in its NEAR Intents balance and pays from it.
- **1Click** is NEAR Intents' swap and deposit API. Veylo uses it for quotes, deposit addresses and funding, and every quote's signature is checked in the browser against the pinned key ([signed intent execution](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution)).
- **Confidential Intents** hold the confidential balance (the `intents.far` verifier) that private payouts are paid from.
- **Signed-intent execution:** each payout is authorised by an off-chain signed intent, so there is no gas and no relayer.
- **NEP-413** is how a wallet signs the sign-in message, the payee list and each payout.
- **NEP-141 USDC** is the money. NEAR RPC is read directly from the browser to check keys and balances.
- **HOT and near-connect:** wallets connect through `@hot-labs/near-connect`, HOT's open wallet connector. HOT Wallet and Meteor are listed first in the picker. The list of wallets comes from near-connect's manifest (<https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json>, version 1.1.0, read 2026-11-12); the wallets Veylo enables, and why the others are left out, are in [docs/WALLETS.md](docs/WALLETS.md).
- **No integration is mandatory** for this hackathon (Q-011): Veylo uses these because they are what it is built on.
- **NEAR-only payouts** for this hackathon: private (confidential USDC on NEAR), and direct (public USDC to a NEAR account, or NEAR), both waiting for their mainnet tests.

## Why there's no relayer

A relayer pays the gas for a transaction a user signed. NEAR's meta-transactions tutorial describes a relayer that pays gas from its own funded account for a signed delegate action, and that can choose which calls it sponsors; its example sponsors one call to one contract ([meta transactions](https://docs.near.org/web3-apps/tutorials/meta-transactions)).

Veylo doesn't run a contract of its own, and its payouts aren't calls to one. A payout is an off-chain signed intent from the treasury's NEAR Intents balance: the wallet signs a message, and NEAR Intents settles it. Nobody pays gas, so there is nothing for a relayer to sponsor. The 1Click flow is documented here: [signed intent execution](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution).

## Email accounts and wallets

You can sign up with an email and a password, or connect an existing NEAR wallet. The email account is for signing in, invitations and notices. It has no signing power.

The owner's wallet signs the payee list and every payout, so Veylo's server can't move money or change who gets paid. Whoever controls an inbox doesn't control the treasury, because the email never touches the wallet's key.

**The Veylo wallet:** at sign-up you can create a wallet in seconds, with no app to install. Its key is generated in your browser, on a separate wallet web address, and kept encrypted there, protected by a passkey (WebAuthn) or a separate wallet password (Argon2id). A recovery phrase is shown once and must be confirmed before the wallet can be used. Veylo's server never sees the key. Only you hold it: if you lose this device and your recovery phrase, Veylo can't recover it. A password reset never restores a wallet, and the email password never unlocks one.

Existing wallets work the same way: whichever wallet signs, the app verifies the signature, the key and the account itself every time.

## How Veylo compares

- **NEAR Business** describes itself as a cross-chain multisig solution for managing confidential digital assets. Its docs describe a multisig smart contract on NEAR, treasuries that are confidential, member roles (Governance, Requestor, Finance) and payment requests that members propose and approve ([docs](https://docs.business.near.com/), read 2026-11-12). The pages we read do not mention payroll, pay runs or payslips.
- **Veylo is a payroll layer** for a confidential treasury: contractors and pay runs, payslips and statements, a CSV for the accountant, and an owner-signed payee list.
- **Where they differ:** NEAR Business is a multisig where several members approve. Veylo has one owner wallet that signs, pays each person privately or directly, and checks every payout in the browser before the owner approves it. Several approvers for a pay run are on the roadmap.
- **What you can check yourself:** the browser checks that refuse a redirected payout can be watched failing on purpose in the demo (row 4 above), and the Privacy screen reads NEAR live.

## How a month works

1. **Fund the treasury.** The Fund screen offers, in this order: USDC on NEAR (an address and a QR code), USDT on NEAR converted to USDC, USDC from another network converted by NEAR Intents, and NEAR converted to USDC. A conversion shows the rate, the fee and the USDC you receive first, and the browser checks the quote's signature before it shows a deposit address. Funding through 1Click was tested on mainnet with USDT from BNB Smart Chain ([docs/EVIDENCE.md](docs/EVIDENCE.md) rows 1 to 5). The NEAR and USDT-on-NEAR options are marked "coming soon" until their live tests pass (spikes S-F2 and S-FT in [VERIFICATION.md](VERIFICATION.md)).
2. **Add a contractor,** one by one or from a CSV (`docs/contractors-sample.csv` shows the format). Enter their name and NEAR account.
3. **Approve their address.** Your treasury wallet signs it onto your payee list.
4. **Review the pay run.** A recurring schedule can prepare the draft three days before payday; nothing is quoted or signed until you open it. You see each amount, route and fee.
5. **Approve payouts in your wallet.** Your browser runs its checks on every payout. A first payout, a new address or an unusual amount needs you to tick "I've checked this". If all checks pass, you approve each payout in your wallet, one approval per payout. There's no gas.
6. **Payouts settle,** usually within a minute or two.
7. **Payslips and statements.** Every settled payout has a payslip (PDF), appears in the ledger and the CSV, and has a verify page.

**Roles:** the owner does everything and signs with the treasury wallet. A preparer creates and edits drafts and contractors, and can't approve addresses or sign. An accountant reads the ledger, payslips, statements, CSV and audit log, and sees a contractor's name and route, nothing else personal.

## Payout statuses

| Status     | What it means                                                                      | What to do                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| QUOTED     | A price is ready and waiting for your approval. Quotes expire after a few minutes. | Review and approve it before the countdown ends.                                                               |
| SIGNED     | You approved it in your wallet.                                                    | Nothing. It's sent next.                                                                                       |
| SUBMITTED  | It's been sent to NEAR Intents for settlement.                                     | Nothing. Wait.                                                                                                 |
| PROCESSING | NEAR Intents is settling it.                                                       | Nothing. Wait a minute or two.                                                                                 |
| SUCCESS    | The contractor has been paid.                                                      | Nothing. The payslip is ready.                                                                                 |
| REFUNDED   | It couldn't be delivered, and the money went back to your treasury.                | Check the contractor's address, then pay again in a new pay run.                                               |
| FAILED     | It didn't go through. Anything not delivered returns to your treasury.             | Read the reason on the status screen, check the ledger's refunded amount, fix the cause, and retry the payout. |
| EXPIRED    | The quote ran out before it was approved. No money moved.                          | Get a new quote and approve it in time.                                                                        |

## Currencies

- **Salaries are set in US dollars.** The treasury is held in USDC.
- **Funding** is in USDC on NEAR, or converted from USDT, NEAR or USDC on another network (the conversions wait for their live tests).
- **Payouts** are in USDC (private or direct). A payout in NEAR is quoted at the time of payout, so the rate, the fee and the NEAR amount are shown before you approve; it waits for its live test (spike S-NR), and it is direct only, because confidential NEAR payouts are not documented as supported.
- **Local currencies are display-only estimates.** A contractor or an organisation can see amounts beside NGN, EUR, GBP, KES, INR and other currencies. The rates come from one public source (open.er-api.com), fetched by Veylo's server and cached for at most an hour; when it can't be reached the screen says "rate unavailable". An estimate is never used to work out, sign or send a payment.
- Bank cash-out in local currency through licensed partners (after the hackathon).

## Private or direct

Each contractor picks one:

- **Private:** paid in confidential USDC on NEAR. The payout isn't publicly linked to your company. Private means no public source we checked links a confidential payout to the company, provided the payout address has never received a public payment from it.
- **Direct:** paid in public USDC to a NEAR account, visible on the NEAR explorer. _Coming soon:_ this route is waiting for its mainnet test (spike S-N in [VERIFICATION.md](VERIFICATION.md)).

Private isn't anonymous: the contractor, Veylo and the settlement service can still see the details. The **Privacy** screen shows the difference live from NEAR mainnet, and the **Verify** page re-checks a direct payout from NEAR on every load.

## Why there's no gas

Payouts aren't on-chain transfers you pay gas for. Your treasury holds its USDC in its NEAR Intents balance, and each payout is authorised by a **signed intent**: a message your wallet signs off-chain. NEAR Intents settles it, so you don't need a relayer or a gas token, and neither does anyone you pay. See the 1Click signed-intent flow: <https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/signed-intent-execution>.

## Reading the CSV export

Export it from **Ledger → Export CSV** for any date range. It lists live payouts only (never test or simulated ones). Dates are ISO 8601 in UTC; amounts are exact to 6 decimal places.

| Column                     | Meaning                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `date`                     | When the payout reached its final status (ISO 8601, UTC).             |
| `pay run period`           | The pay run it belongs to, e.g. `2026-11`.                            |
| `contractor name`          | Who was paid.                                                         |
| `amount`                   | What the contractor received.                                         |
| `currency`                 | Always `USDC`.                                                        |
| `route`                    | How they were paid, e.g. `USDC confidential balance on NEAR`.         |
| `chain`                    | Where it was delivered, e.g. `NEAR`.                                  |
| `recipient`                | The contractor's payout address.                                      |
| `delivery fee`             | The network's delivery fee.                                           |
| `total fee`                | Everything paid on top of `amount`.                                   |
| `status`                   | The final status (see the table above).                               |
| `reconciled`               | `yes` once the payout was checked against the treasury's balance.     |
| `refunded amount`          | Any amount returned to the treasury.                                  |
| `deposit address`          | The settlement address for this payout.                               |
| `intent hash`              | The ID of the signed intent.                                          |
| `NEAR tx hash`             | The NEAR transaction(s), space-separated.                             |
| `destination tx hash`      | The delivery transaction, if public.                                  |
| `destination explorer URL` | A link to the delivery transaction, if public.                        |
| `transaction link`         | A link to look the payout up, or `confidential` for a private payout. |
| `payslip ID`               | The payslip's ID, as shown in the app.                                |

Example rows (made-up values):

```csv
date,pay run period,contractor name,amount,currency,route,chain,recipient,delivery fee,total fee,status,reconciled,refunded amount,deposit address,intent hash,NEAR tx hash,destination tx hash,destination explorer URL,transaction link,payslip ID
2026-11-26T10:05:00.000Z,2026-11,Ada Lovelace,4200.000000,USDC,USDC confidential balance on NEAR,NEAR,ada-l.near,0.000000,0.420000,SUCCESS,yes,0.000000,8f3c…,ih-1…,2cJr…,,,confidential,6f1e2d3c-0000-4000-8000-000000000001
```

## Safety, in one paragraph

Your treasury wallet is what adds someone to your payee list, and your browser verifies that signed list on NEAR itself. Before you approve a payout, your browser checks that the quote is signed by NEAR Intents, pays someone on your signed list, uses a key your treasury controls, and pays exactly the right amount. If anything doesn't match, approving is locked. A payee's address change waits 24 hours before it can be approved, and Veylo's own servers can't change who gets paid or how much.

## Built with

- **Language and tools:** TypeScript 5.9.3, Node 24, pnpm 11, Vitest 4.1.12, Prettier 3.9.10, esbuild 0.28.2, tsx 4.23.15, Zod 4.6.7.
- **API:** Fastify 5.12.8 (with cookie, cors, helmet and rate-limit plugins), Drizzle ORM 0.45.4, PostgreSQL (`pg` 8.23.1), pg-boss 12.38.1 (job queue), pino 10.4.0.
- **Web:** Next.js 16.4.3 (static export), React 19.3.1, three.js 0.186.1, Phosphor Icons 2.1.10, Fontsource (Inter Tight, IBM Plex Mono, Instrument Serif) 5.3.0, sharp 0.35.5 (images).
- **NEAR:** `@hot-labs/near-connect` 0.12.0 (wallet connection), near-api-js 7.4.0 and `@defuse-protocol/intents-sdk` 0.95.0 (in the `verification/` mainnet test scripts), `@noble/curves`, `@noble/hashes`, `@noble/ciphers` 2.4.0, `@scure/base` 2.4.0 and `@scure/bip39` 2.4.0 (cryptography and the recovery phrase), `qrcode-generator` 2.0.4 (the funding QR code).
- **Checks:** Playwright 1.64.1 (browser), axe-core 4.14.0 (accessibility), Lighthouse 13.5.0 (performance).
- **Services:** NEAR Intents (1Click API), NEAR RPC (fastnear), the Meteor wallet.
- **AI coding assistant:** Claude Code (Anthropic) wrote and tested the code with the founder.
- **Written during the hackathon:** all code in this repository was written during the hackathon window (from the 2026-10-19 announcement), with no pre-existing project (HACKATHON.md Q-001 and Q-005).

## Proven on mainnet

The mechanisms Veylo relies on were tested on NEAR mainnet with tiny amounts (0.03 to 2 USDC) by test scripts, not by the product. [docs/EVIDENCE.md](docs/EVIDENCE.md) lists every transaction, and `pnpm verify` re-checks each row against public RPC with no keys:

- funding a treasury through a 1Click deposit address, which settles into the NEAR Intents balance;
- payouts from that balance, public and confidential, delivered on other chains;
- a private receipt from one confidential balance to another, which has no public transaction by design;
- a cash-out from the confidential balance.

Not yet proven: payouts made by the product itself (EVIDENCE.md section 1 says "None yet"), the direct USDC route on NEAR (spike S-N), funding with USDC on NEAR through 1Click as a same-asset quote, funding with NEAR (S-F2) or USDT on NEAR (S-FT), payouts in NEAR (S-NR), the Veylo embedded wallet on mainnet (S-EW), a contractor's cash-out from the portal (S-P), and each connected wallet other than Meteor with a real wallet. All of them are prepared in [VERIFICATION.md](VERIFICATION.md) and refuse to run without the founder's approval. NEAR Intents has no testnet (HACKATHON.md Q-007), so these tests use mainnet.

## Hackathon

Built at NEAR HACKATHON, for the Real-World Money (`realworld`) and Privacy & Private AI (`privacy`) tracks. Licence: MIT ([LICENSE](LICENSE)).

## Roadmap after the hackathon

- Other chains: the code for Base, Arbitrum and Solana payouts exists and is switched off.
- Several approvers for a pay run (the design is in [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md)).
- Bank cash-out in local currency through licensed partners (after the hackathon).

---

## For developers

- **Stack:** TypeScript monorepo (pnpm). API: Fastify and PostgreSQL (`apps/api`). Web: Next.js static export with a strict CSP (`apps/web`), plus a separate wallet bridge origin (`apps/web/bridge`). Shared packages: `packages/core`, `packages/intents`, `packages/chains`, `packages/contract`, `packages/db`.
- **Check everything:** `pnpm install --frozen-lockfile`, then `pnpm verify`.
- **The whole story, no keys:** `pnpm demo`. **Click through with demo data:** `pnpm dev:web`. **A real wallet, locally:** `pnpm dev:wallet`.
- **Browser checks** (need Chrome): `pnpm --filter @veylo/web check:pages` (a crawler that follows every link and button, the loading, error and empty state of every page, every page at 17 screen sizes from 320 px to 1920 px, and axe), `check:embedded` (the Veylo wallet over two real origins), `check:browser` and `check:lighthouse`. **Wallets:** [docs/WALLETS.md](docs/WALLETS.md); `pnpm wallets:refresh` prints what changed in the wallet manifest and writes nothing without the founder's approval.
- **Deploy:** [docs/DEPLOY.md](docs/DEPLOY.md). Architecture: [ARCHITECTURE.md](ARCHITECTURE.md). Decisions: [DECISIONS.md](DECISIONS.md).
- **Security:** [SECURITY.md](SECURITY.md). **Privacy:** [PRIVACY.md](PRIVACY.md). **Public readiness:** [docs/PUBLIC-READINESS.md](docs/PUBLIC-READINESS.md).

## Licence

MIT. See [LICENSE](LICENSE).
