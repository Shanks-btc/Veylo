# Veylo codebase map

What exists today. For the design, see `ARCHITECTURE.md`; for locked decisions, see `DECISIONS.md`.

## Requirements

- Node 24 (`.nvmrc`)
- pnpm 11 (`packageManager` in `package.json`)

No Docker or local Postgres is needed for `pnpm verify`. Tests use PGlite, an embedded Postgres, unless run through `pnpm test:pg`.

## Commands

| Command                            | What it does                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm install`                     | Installs dependencies                                                                    |
| `pnpm verify`                      | Typechecks every package, runs every test and prints a report. Exits non-zero on failure |
| `pnpm test`                        | Runs all tests with Vitest                                                               |
| `pnpm typecheck`                   | Typechecks every package                                                                 |
| `pnpm format`                      | Formats with Prettier                                                                    |
| `pnpm --filter @veylo/db generate` | Generates a migration after a schema change                                              |
| `pnpm db:migrate`                  | Applies pending migrations to `DATABASE_URL` and prints which. Never a schema push       |
| `pnpm evidence:generate`           | Writes `docs/EVIDENCE.md` from `DATABASE_URL` and the Phase 2 records. Deterministic     |
| `pnpm worker:settlement`           | The settlement worker (session key only)                                                 |
| `pnpm worker:agents`               | The agent worker placeholder (agent key only; no jobs until slice 8)                     |
| `pnpm test:pg`                     | Runs the db and api suites on the real Postgres in `DATABASE_URL`. Needs CREATEDB        |

## Layout

| Path                           | Contents                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `apps/api/`                    | Fastify API. `buildServer(deps)` in `src/app.ts`, entry point `src/server.ts`                          |
| `packages/core/`               | Pure domain logic. No I/O, and no dependencies                                                         |
| `packages/intents/`            | NEP-413 serialization and verification                                                                 |
| `packages/chains/`             | Address validation, NEAR RPC reader and the key-ownership check                                        |
| `packages/secrets/`            | Envelope encryption: per-org data keys wrapped by a master key, bound by associated data               |
| `packages/db/`                 | Drizzle schema, migrations and repositories                                                            |
| `packages/config/`             | Environment validation                                                                                 |
| `tools/verify/`                | `pnpm verify`, plus repository guard tests                                                             |
| `.github/workflows/verify.yml` | CI, running `pnpm verify`                                                                              |
| `verification/`                | Phase 2 scripts and evidence. Not in the workspace. Never import from it or copy its dependencies (L5) |

## Key logic

| Logic                                                        | File                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Money: bigint amounts, parsing and formatting                | `packages/core/src/money.ts`                                            |
| Payout attempt states, transitions, retry rules              | `packages/core/src/payout-attempt.ts`                                   |
| Pay run states, transitions, status derivation               | `packages/core/src/pay-run.ts`                                          |
| Fee math and the basis-point rounding rule                   | `packages/core/src/fees.ts`                                             |
| Live and simulated mode                                      | `packages/core/src/mode.ts`                                             |
| Database tables and idempotency constraints                  | `packages/db/src/schema.ts`                                             |
| Audit log append-only trigger                                | `packages/db/migrations/`                                               |
| Supported payout routes and address hygiene rules            | `packages/core/src/routes.ts`, `hygiene.ts`                             |
| Address validation per chain                                 | `packages/chains/src/addresses.ts`                                      |
| 1Click client, dry quotes only                               | `packages/intents/src/oneclick.ts`                                      |
| Canonical payee messages and `payable` rules                 | `packages/core/src/payee.ts` (hashing: `packages/intents/src/payee.ts`) |
| Live quotes, only funding and shield (L30)                   | `packages/intents/src/oneclick-treasury.ts`                             |
| Pay-run review flags                                         | `packages/core/src/review.ts`                                           |
| 1Click quote signature check (gate A, server side)           | `packages/intents/src/quote-signature.ts`                               |
| Payability: the server replica of gate B                     | `apps/api/src/payability.ts`                                            |
| Signing, submit and retry routes                             | `apps/api/src/payout-routes.ts`                                         |
| Settlement jobs (poll, reconcile, resolve, expire, release)  | `apps/api/src/settlement.ts`, run by `apps/api/src/worker.ts`           |
| Ledger, payslips, CSV export, audit view                     | `apps/api/src/reporting-routes.ts`                                      |
| Explorer links (official domains only)                       | `packages/chains/src/explorers.ts`                                      |
| EVIDENCE.md and its re-check against public RPC              | `tools/verify/src/evidence.ts`                                          |
| Per-service environment loaders                              | `packages/config/src/index.ts`                                          |
| Repository rules, such as core purity and no floats on money | `tools/verify/src/guards.test.ts`                                       |

## Rules for changes

- `packages/core` must not import from other packages or do any I/O. Time is passed in as a parameter.
- Money is a `bigint` in smallest units. Floating point is not used on amounts.
- Database amounts: USDC uses `bigint`. Any other asset uses `numeric(78,0)`, mapped to `bigint` in the app (L20).
- Every tenant-scoped child table references its parent with a composite foreign key including `org_id` (L20).
- Route code reaches tenant tables through `packages/db/src/repositories.ts`, whose tenant functions all take `orgId`. Non-members get 404. New org-scoped routes must be added to `apps/api/src/tenant-isolation.test.ts`.
- Memberships are never deleted. Removed members count as non-members everywhere (L22).
- `TRUST_PROXY_HOPS` defaults to 0. Verify the right value against the real host at deploy time. Above 0, the API must be reachable only through the proxy (L26).
- Destination addresses are never edited: a change is a new row, and the old one is superseded (L25).
- Payee approvals and registry heads must be signed by the treasury account itself (L28). The canonical messages in `packages/core/src/payee.ts` are signed bytes: changing them needs a new schema version, and the golden vectors will fail.
- Two master keys (L31): `SESSION_ENCRYPTION_KEY` in the API only, `AGENT_KEY_MASTER_KEY` in the worker only. The API must never load the agent key.
- `funding-quote`, `shield-request` and `session-request` are limited per route to 60 per org and 30 per user per hour, set with `TREASURY_LIMIT_ORG_PER_HOUR` and `TREASURY_LIMIT_USER_PER_HOUR`. Limits are in memory, per API instance (L32).
- Payout quotes go only through `createPayoutQuote`, which checks the recipient against the owner-signed payee and verifies 1Click's quote signature (L34). Simulated runs make dry quotes only and never show a success.
- Signed payloads are bearer authorizations (L33): encrypted, never logged or returned, deleted once harmless. An uncertain submit is resubmitted identical, never re-signed (L34). Worker jobs must stay idempotent.
- CSV cells go through `toCsv` (RFC 4180 and formula neutralizing), amounts through `formatFixed`. Simulated records never reach the CSV or EVIDENCE.md.
- There is no generic live-quote method. Add a purpose-specific function with its own guard (L30). 1Click session tokens are encrypted at rest and never logged or returned.
- Pin every dependency to an exact version.
- Secrets never go in the repository. `.env.example` holds names and comments only.
- After changing `packages/db/src/schema.ts`, generate a migration. Don't edit applied migrations.
- `pnpm verify` reports unbuilt checks as SKIPPED. Never report an unimplemented check as passed.

## Working rules

Standing rule from now on, for this slice and every future slice: do not stop to ask me questions. When a choice comes up, pick the most secure option that fits DECISIONS.md and ARCHITECTURE.md, implement it, and list it in your report under a heading "Decisions I made" with one line of reasoning each. I will overrule in my review if needed.

Stop and ask only for these: anything irreversible, any mainnet transaction or spending of funds, any change to bytes a wallet or the treasury signs (message formats, hashes, canonical JSON), or deleting data or files outside the slice.
