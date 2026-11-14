# Deploy runbook

How Veylo's backend runs in production, and what to check at each deploy. Decisions: L23 (same-site
web and API), L24 (built JS in production), L26 (proxy check), L31 and L36 (key separation), L37
(build, readiness, shutdown), L38 (per-process config, worker migration guard, client-IP logging).

**The live deployment is on Vercel and Neon (section 14, L64).** Sections 1 to 10 describe the
long-running form of the same backend (a server process and a worker process, which `pnpm start` and
`pnpm worker:settlement` still run, and which the tests cover); on Vercel the server is a function and
the worker is two cron routes. The checks in sections 5, 7, 10 and 12 apply to both.

Railway behaviour stated here cites the Railway docs page it comes from, fetched 2026-11-07. Vercel
behaviour cites the Vercel docs page it comes from, fetched 2026-11-13. Anything not confirmed from a
fetched page is marked **(unverified)**.

## Contents

1. Services
2. Build and start commands
3. Environment variables
4. Pre-deploy step: migrations
5. Health and readiness
6. Shutdown
7. Proxy check (L26)
8. Domains: same-site web and API (L23)
9. Not deployed yet
10. Checklist for each deploy
11. Local demo for review (`pnpm dev:web`)
12. Wallet bridge (`wallet.<domain>`, L44)
13. Real-wallet test on your computer (`pnpm dev:wallet`)
14. Vercel: the deployed app (web, wallet bridge, API, database, cron)
15. The 1Click partner key
16. Email delivery (not built yet)
17. Exchange rates for local-currency estimates

## 1. Services

| Service             | Host    | Runs                                                             | Public                                               |
| ------------------- | ------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `api`               | Railway | `node apps/api/dist/bin/server.js`                               | Yes, only through Railway's proxy, on the API domain |
| `worker:settlement` | Railway | `node apps/api/dist/bin/worker.js`                               | No. It opens no port.                                |
| Postgres            | Railway | Postgres 17 (CI tests 17.11)                                     | No. Private network only.                            |
| `web`               | Vercel  | The static app and a separate wallet bridge (sections 12 and 14) | Yes                                                  |

The agents worker is not deployed: agents are out of scope (L46, section 9).

## 2. Build and start commands

Production runs built JavaScript only, never tsx (L24). The same build serves both Railway services.

|                            | Command                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Install                    | `pnpm install --frozen-lockfile` (with dev dependencies: the build needs esbuild)                                  |
| Build                      | `pnpm build`. Writes `apps/api/dist/bin/{server,worker,worker-agents,migrate}.js` and `apps/api/dist/migrations/`. |
| Pre-deploy (`api` only)    | `pnpm db:migrate`, which runs `node apps/api/dist/bin/migrate.js`                                                  |
| Start, `api`               | `pnpm start`, which runs `node apps/api/dist/bin/server.js`                                                        |
| Start, `worker:settlement` | `pnpm worker:settlement`, which runs `node apps/api/dist/bin/worker.js`                                            |

Node 24 (`.nvmrc`) and pnpm 11 (`packageManager` in `package.json`). npm packages are not bundled. They
load from `node_modules` at runtime, so the install must be present where the service starts. The
build fails if the bundle imports an npm package that isn't a runtime dependency of `@veylo/api`.

## 3. Environment variables

Names only. Never put a value in this repository. Each process loads only its own set (L38) and fails
at start, naming the variable, if one it needs is missing or invalid. **Secret** means: never print
it, and never give it to a service that doesn't load it. How Railway stores secret variables
**(unverified)**.

### `api`

| Name                              | Secret                          | Required   | Notes                                                                                                             |
| --------------------------------- | ------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | **Secret** (holds the password) | Yes        | Railway Postgres private URL                                                                                      |
| `ONECLICK_PARTNER_KEY`            | **Secret**                      | No         | 1Click partner JWT. Without it live quotes say "Live quotes are not connected yet" and fail closed (section 15).  |
| `CRON_SECRET`                     | **Secret**                      | No         | Vercel only (section 14): the bearer token the internal cron routes check. Without it those routes don't exist.   |
| `SESSION_ENCRYPTION_KEY`          | **Secret**                      | Yes        | 32 random bytes, base64. API tier only (L31).                                                                     |
| `NODE_ENV`                        | No                              | Yes        | `production`                                                                                                      |
| `LOG_LEVEL`                       | No                              | Yes        | `info`                                                                                                            |
| `AUTH_RECIPIENT`                  | No                              | Yes        | The app identifier wallets sign for                                                                               |
| `WEB_ORIGIN`                      | No                              | Yes        | The web app's origin, no path (section 8)                                                                         |
| `PORT`                            | No                              | No (3000)  | Railway injects `PORT` for the app to listen on ([healthchecks](https://docs.railway.com/reference/healthchecks)) |
| `TRUST_PROXY_HOPS`                | No                              | No (0)     | Set only after the check in section 7                                                                             |
| `LOG_CLIENT_IP`                   | No                              | No (false) | `true` only during the section 7 check, then back to `false`                                                      |
| `NEAR_RPC_URL`                    | No                              | No         | Default `https://rpc.fastnear.com`                                                                                |
| `SESSION_TTL_HOURS`               | No                              | No (24)    |                                                                                                                   |
| `TREASURY_LIMIT_ORG_PER_HOUR`     | No                              | No (60)    |                                                                                                                   |
| `TREASURY_LIMIT_USER_PER_HOUR`    | No                              | No (30)    |                                                                                                                   |
| `PAYOUT_QUOTE_DEADLINE_MINUTES`   | No                              | No (15)    |                                                                                                                   |
| `REVIEW_AMOUNT_DEVIATION_PERCENT` | No                              | No (25)    |                                                                                                                   |
| `ONECLICK_QUOTE_PUBLIC_KEY`       | No                              | No         | Default: the key pinned in S-C                                                                                    |

### `worker:settlement`

Only what it reads. It does not need `AUTH_RECIPIENT`, `WEB_ORIGIN` or `PORT`, and opens no port. It
keeps the session key to decrypt the signed payloads it resubmits (L36), and never holds the agent key.

| Name                        | Secret                          | Required | Notes                                                                                                                       |
| --------------------------- | ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | **Secret** (holds the password) | Yes      | Same database as `api`                                                                                                      |
| `ONECLICK_PARTNER_KEY`      | **Secret**                      | No       | Same value as `api`. Without it every status check is refused ("Live quotes are not connected yet") and nothing is changed. |
| `SESSION_ENCRYPTION_KEY`    | **Secret**                      | Yes      | Same value as `api` (L36)                                                                                                   |
| `NODE_ENV`                  | No                              | Yes      | `production`                                                                                                                |
| `LOG_LEVEL`                 | No                              | Yes      | `info`                                                                                                                      |
| `NEAR_RPC_URL`              | No                              | No       | Default `https://rpc.fastnear.com`                                                                                          |
| `ONECLICK_QUOTE_PUBLIC_KEY` | No                              | No       | Default: the key pinned in S-C                                                                                              |

### Pre-deploy: `migrate`

| Name           | Secret                          | Required | Notes                                      |
| -------------- | ------------------------------- | -------- | ------------------------------------------ |
| `DATABASE_URL` | **Secret** (holds the password) | Yes      | The only variable the migration step reads |

### `worker:agents` (out of scope, L46: never deployed)

| Name                   | Secret                          | Required | Notes                                                                         |
| ---------------------- | ------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`         | **Secret** (holds the password) | Yes      |                                                                               |
| `ONECLICK_PARTNER_KEY` | **Secret**                      | Yes      |                                                                               |
| `NEARAI_API_KEY`       | **Secret**                      | Yes      | NEAR AI Cloud key                                                             |
| `AGENT_KEY_MASTER_KEY` | **Secret**                      | Unused   | Unused while agents are out of scope (L46). Never on any other service (L31). |
| `NODE_ENV`             | No                              | Yes      | `production`                                                                  |
| `LOG_LEVEL`            | No                              | Yes      | `info`                                                                        |

### Never set

`AGENT_KEY_MASTER_KEY` and `NEARAI_API_KEY` on `api` or `worker:settlement`. `SESSION_ENCRYPTION_KEY`
on `worker:agents`.

### Postgres

Managed by Railway. Reference its private connection URL from each service's `DATABASE_URL`. Don't
enable a public TCP proxy for it **(unverified: the exact Railway setting)**.

## 4. Pre-deploy step: migrations

Set `pnpm db:migrate` as the `api` service's pre-deploy command. Railway runs pre-deploy commands
"between building and deploying your application", and "if your command fails, it will not be retried
and the deployment will not proceed"; it runs in a separate container without volumes, with no time
limit unless a Pre-deploy Timeout is set
([pre-deploy command](https://docs.railway.com/guides/pre-deploy-command)). The migration command:

- applies pending migration files with Drizzle's migrator, never a schema push;
- takes a Postgres advisory lock, so two deploys run one after the other;
- exits non-zero on failure, which stops the deploy;
- loads only `DATABASE_URL`, through the config package like every other process (L39), and never
  prints it.

Only the `api` service runs it, so deploy `api` first whenever a deploy includes a migration. Both
workers check the database and migration state at start, the same check `/ready` uses (L38, L39). If
any of these fails, the worker logs one line and exits 1:

| Log line                                           | Meaning                                         |
| -------------------------------------------------- | ----------------------------------------------- |
| `… refusing to start: migrations_pending: <count>` | The pre-deploy migration hasn't run yet         |
| `… refusing to start: migration_state_unreadable`  | The migration table can't be read (permissions) |
| `… refusing to start: database_unreachable`        | The database can't be reached                   |

The line never contains the database URL or password. A worker deployed ahead of its migration won't
run until `api`'s pre-deploy step has applied it. If it says `database_unreachable`, check the
worker's `DATABASE_URL` reference and that Postgres is up.

## 5. Health and readiness

| Path          | Meaning                                                     | 200                  | 503                                 |
| ------------- | ----------------------------------------------------------- | -------------------- | ----------------------------------- |
| `GET /health` | Liveness: the process answers. Never touches the database.  | `{"status":"ok"}`    | n/a                                 |
| `GET /ready`  | Readiness: the database answers and no migration is pending | `{"status":"ready"}` | `{"status":"not_ready","reason":…}` |

`reason` is one of `database_unreachable`, `migrations_pending: <count>` or
`migration_state_unreadable`. It never holds a URL, a password or a driver message.

Set the `api` service's healthcheck path to `/ready` in its service settings. From
[Railway's healthcheck docs](https://docs.railway.com/reference/healthchecks):

- Railway calls the path until it gets "any `2xx` status code", before routing traffic to the new
  deployment. The default timeout is 300 seconds (`RAILWAY_HEALTHCHECK_TIMEOUT_SEC` overrides it).
- "Railway does not monitor the healthcheck endpoint after the deployment has gone live." `/ready`
  therefore gates deploys only. Use `/health` for any ongoing liveness monitoring.
- Probes come from the hostname `healthcheck.railway.app`. The API doesn't filter by host, so nothing
  needs allowing.

The worker has no HTTP endpoint and no healthcheck. Check it through its logs:
`worker:settlement started` on boot, or the `refusing to start` line above.

## 6. Shutdown

On SIGTERM or SIGINT:

- `api` stops accepting connections, lets in-flight requests finish, closes the database pool, and
  exits 0.
- `worker:settlement` stops queueing sweeps, then stops pg-boss gracefully. pg-boss fetches no new
  jobs and waits up to 20 s for running ones. A job still running then stays in pg-boss and is retried
  after it expires; every job is an idempotent sweep. Then it closes the pool and exits 0.

Either process exits 1 if a step fails, or if shutdown takes over 30 s.

When a new deployment replaces an old one, "the previous deployment is sent a SIGTERM signal and given
time to gracefully shutdown before being forcefully stopped with a SIGKILL"
([deployment teardown](https://docs.railway.com/guides/deployment-teardown)). That time is
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, "the SIGTERM to SIGKILL buffer time (in seconds), its default
value is 0" ([variables](https://docs.railway.com/reference/variables)). **Set it to 30 on `api` and
`worker:settlement`**, or the graceful shutdown above is cut short. Whether a manual stop or service
removal also sends SIGTERM first **(unverified)**.

## 7. Proxy check (L26)

`TRUST_PROXY_HOPS` sets how many proxies in front of the API are trusted to report the client's IP
(`X-Forwarded-For`). Rate limits key on that IP. Too few hops, and every client shares the proxy's
IP. Too many, and a client can spoof its own. With `TRUST_PROXY_HOPS` > 0, the API must be reachable
only through the proxy. Do these steps at the first deploy, and again whenever the host or domain
setup changes. This runbook doesn't state a hop count: measure it.

Request logs carry no client IP unless `LOG_CLIENT_IP=true` (L38). The IP is personal data, so turn it
on only for this check.

**A. Find the hop count.**

1. Set `LOG_CLIENT_IP=true` and deploy with `TRUST_PROXY_HOPS` unset (0).
2. From a machine whose public IP you know (for example, from `https://api.ipify.org`), run
   `curl -s https://<api-domain>/health`.
3. In the `api` logs, find that request's `incoming request` line. Its `req.ip` is the address the API
   resolved. With 0 hops it's the proxy's address, not yours.
4. Set `TRUST_PROXY_HOPS=1`, redeploy, and repeat step 2. If `req.ip` is now your IP, 1 is right. If
   it's still a proxy address, try 2, and so on. Use the smallest value that shows your IP.
5. Confirm a client can't spoof it:
   `curl -s -H "X-Forwarded-For: 203.0.113.7" https://<api-domain>/health`. `req.ip` must still be
   your real IP, not 203.0.113.7.
6. Set `LOG_CLIENT_IP=false` (or remove it) and redeploy. Check that a new `incoming request` line has
   no `ip` field.

**B. Confirm the API isn't directly reachable** (Railway networking details here are
**(unverified)**).

1. In Railway, check that the `api` service has no public TCP proxy and that its only public address
   is the HTTP domain. The private `*.railway.internal` address shouldn't be reachable from the
   internet.
2. From outside Railway, try the service's private hostname and any IP or port you can find for it.
   Each must fail to connect.
3. Postgres and `worker:settlement` must have no public address at all.

Record the date, the hop count and the results of A5, A6 and B2 in the deploy notes. If either check
fails, set `TRUST_PROXY_HOPS=0` until it's fixed. Rate limits then group all clients, which is safe
but strict.

## 8. Domains: same-site web and API (L23)

**On Vercel's default domains this is met another way (section 14):** `*.vercel.app` is on the Public
Suffix List, so the web app forwards `/api/*` to the API project and the cookie belongs to the web origin.
The rest of this section is the custom-domain form, which would let that forwarding go.

Sessions use an httpOnly, Secure, `SameSite=Lax` cookie. Production requires the web app and the API
on the same site: two subdomains of one registrable domain, such as `app.<domain>` (Vercel) and
`api.<domain>` (Railway, custom domain). Platform default domains (`*.vercel.app`,
`*.up.railway.app`) are different sites, so the cookie wouldn't work across them. The domain is the
founder's choice and isn't made yet (open action item).

- Point `api.<domain>` at the Railway `api` service and `app.<domain>` at Vercel, both over HTTPS.
- Set `WEB_ORIGIN` on `api` to `https://app.<domain>` exactly, with no path or trailing slash. CORS
  allows only that origin.
- Set `AUTH_RECIPIENT` to the app identifier that wallets sign for.

## 9. Not deployed yet

- **Agents worker** (`node apps/api/dist/bin/worker-agents.js`): out of scope (L46), never deployed. It has no
  jobs; it checks migrations and exits. Its variables are in section 3, and it never gets
  `SESSION_ENCRYPTION_KEY` (L31, L36).
- Nothing else waits: the web app, the wallet bridge, the API, the database and the cron jobs are deployed (section 14). What the founder still sets is listed in the W7 report and in section 14 ("Variables per project").

## 10. Checklist for each deploy

1. CI is green: `pnpm verify` and the Postgres job (`pnpm build`, `pnpm db:migrate`, `pnpm test:pg`).
2. The build succeeds on the host (`pnpm build`).
3. The pre-deploy `pnpm db:migrate` succeeds.
4. `GET /ready` returns 200 before traffic switches.
5. The worker logs `worker:settlement started`, not `refusing to start`.
6. `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` is 30 on `api` and `worker:settlement`.
7. `LOG_CLIENT_IP` is unset or `false`, except during a section 7 check.
8. On the first deploy, or after a proxy or domain change: section 7 is done and recorded.
9. No secret appears in any log or in this repository.

## 11. Local demo for review (`pnpm dev:web`)

This runs the web app on your computer with made-up data. You can click through the landing page and all 12 app screens without the API, a database or a wallet. It is not a deploy, and it is never used in production.

1. Install once: `pnpm install`.
2. From the repository root, run `pnpm dev:web`.
3. Open http://localhost:3000 for the landing page, and http://localhost:3000/app for the app.

What to expect:

- The people and amounts are made up. They are the same test data the browser checks use (`apps/web/scripts/demo-data.mjs`).
- The demo API runs at http://localhost:4100 and answers reads only. Saving, approving or signing returns "The demo is read-only".
- Wallet buttons don't connect. The demo runs no wallet bridge (section 12).
- The image step needs `design/images/LICENSES.md` naming every photo. Without it, `pnpm dev:web` stops and says so.
- Stop it with Ctrl+C.

## 12. Wallet bridge (`wallet.<domain>`, L44)

The wallet code runs on its own origin, so the app keeps its strict CSP. The app frames a bridge page and talks to it only by postMessage, with exact origin checks on both sides. The app verifies every signature, key and account itself, whichever wallet signed; the bridge decides nothing and can't reach the Veylo API.

There is one page for each enabled external wallet, each with its own policy, and one page for the Veylo wallet:

| Item        | Value                                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin      | Its own subdomain, e.g. `wallet.veylo.app`. Never the app or API origin.                                                                                                                                                                            |
| Host        | Vercel, a separate project from the web app (static files only).                                                                                                                                                                                    |
| Build       | `BRIDGE_APP_ORIGIN=https://app.<domain> NEXT_PUBLIC_NEAR_RPC_URL=<rpc> NEXT_PUBLIC_API_ORIGIN=https://api.<domain> node apps/web/scripts/build-bridge.mjs`                                                                                          |
| Output      | `apps/web/out-bridge/`: `w/<wallet id>/index.html` (one per enabled wallet), `embedded/index.html` (the Veylo wallet), `main.js`, `embedded.js`, `wallets/` (the SHA-256-pinned executors), `wallet-icons/`, `vercel.json` (headers for every page) |
| App setting | `NEXT_PUBLIC_WALLET_BRIDGE_ORIGIN=https://wallet.<domain>` on the web app build                                                                                                                                                                     |

`NEXT_PUBLIC_API_ORIGIN` is read by the bridge build only to refuse a build whose CSP would reach the API.

**An external wallet's page** (`/w/<id>/`; policy from `apps/web/scripts/bridge-csp.mjs`, hosts from `apps/web/src/wallet/wallets.lock.json` and the review next to it):

- `script-src 'self' 'unsafe-inline'` and `style-src 'self' 'unsafe-inline'`, because the wallet's sandboxed executor inherits this page's policy;
- `connect-src` the wallet's reviewed hosts and the NEAR RPC origin, never the API; `img-src` and `frame-src` likewise only what that wallet's review lists;
- `frame-ancestors https://app.<domain>` (header only), so only the app can frame it;
- `default-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`.

The executors are served from this origin under a name that carries their SHA-256. A test and `pnpm verify` recompute each hash; a changed executor is a reviewed change (`pnpm wallets:refresh`, which writes nothing without the founder's approval). Which wallets are enabled, and why the others are not, is in [WALLETS.md](WALLETS.md).

**The Veylo wallet page** (`/embedded/`): `script-src 'self'` and `connect-src 'none'`, so it can't make a network request of any kind; the key is made and kept on this origin and never leaves it. Its `Permissions-Policy` allows passkeys (`publickey-credentials-create=(self)`, `publickey-credentials-get=(self)`) on this page only. The web app's WebAuthn relying-party id is this wallet origin, so the passkey belongs to the wallet origin, not the app.

Check after each deploy:

1. Open `https://wallet.<domain>/` directly. It says "This page only works inside the Veylo app".
2. The response headers of `/w/<id>/` and `/embedded/` include their policies above, with `frame-ancestors` naming only the app origin.
3. In the app, sign in with the Veylo wallet and with one external wallet. The browser console shows no CSP errors on the app origin.
4. `pnpm verify` passes its web-build step: every enabled wallet has a page with the reviewed policy and a pinned executor, and the app's own policy names no wallet host.

## 13. Real-wallet test on your computer (`pnpm dev:wallet`)

This is the test to do before anything is deployed. It runs the real app, the real wallet bridge and the real API against your local database, so you can connect your Meteor wallet and sign in. Nothing is deployed, and no payout is quoted, signed or sent unless you do it yourself in the app.

| Part   | Where                 | What                                                          |
| ------ | --------------------- | ------------------------------------------------------------- |
| App    | http://localhost:3000 | The production build of the web app, with its real strict CSP |
| Bridge | http://127.0.0.1:3001 | The wallet bridge on a different origin, with its own CSP     |
| API    | http://localhost:4000 | The real API, on your local database (not demo data)          |

Steps:

1. Start a local Postgres 17 and create an empty database.
2. Put its connection URL in a `.env` file at the repository root as `DATABASE_URL=` (see `.env.example`), together with `ONECLICK_PARTNER_KEY=` and `SESSION_ENCRYPTION_KEY=`. Never commit `.env`.
3. `pnpm install`, then `pnpm build` and `pnpm db:migrate` to apply the migrations to that database.
4. Run `pnpm dev:wallet`. It builds the API, the app and the bridge, then serves them.
5. Open http://localhost:3000, click **Connect NEAR wallet**, and approve the sign-in in Meteor.

How it stays local:

- The two local origins are named exactly in the app CSP, the bridge CSP and both postMessage origin checks, and nowhere else.
- The build scripts accept a local origin only when `pnpm dev:wallet` asks for it (`VEYLO_LOCAL_WALLET_TEST=1`). The output goes to `apps/web/out-local` and `apps/web/out-bridge`, never to `out/`, so a production build cannot carry a local origin. `pnpm verify` checks this, and `apps/web/src/csp.test.ts` tests it.
- It stops with a message, and starts nothing, if `DATABASE_URL` is missing. If the API stops, the whole command stops.
- Stop it with Ctrl+C.

## 14. Vercel: the deployed app (web, wallet bridge, API, database, cron)

Veylo is deployed on Vercel (slice W7, L64): the web app, the wallet bridge and the API are three separate Vercel projects, each on its own origin, with Postgres on Neon (installed through the Vercel Marketplace) and the background work run as Vercel Cron Jobs. There is no demo project and no demo label anywhere in the deployed app: it is the real app, and `pnpm demo` (a local, no-wallet, no-money run) stays as the judge's way to try it on their own computer.

**Keep the deployment up until at least 2026-11-25.** NEAR HACKATHON judging starts 2026-11-16, and the organisers' answer to Q-012 is that a working demo must stay available to 2026-11-18 and, ideally, to 2026-11-25. If the account, a plan limit or a billing change would take any of the three projects, the database or the cron jobs down before then, move it first. Check on 2026-11-16 and 2026-11-25 (see "After each deploy").

### The three projects

| Project        | URL                               | Serves                                                                                      | Built from                                          |
| -------------- | --------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `veylopay`     | `https://veylopay.vercel.app`     | The static web app (36 pages). Forwards `/api/*` to the API project (see below).            | `apps/web/out`, staged to `deploy/web`              |
| `veylo-wallet` | `https://veylo-wallet.vercel.app` | The wallet bridge: one page per enabled wallet, the Veylo wallet page, the pinned executors | `apps/web/out-bridge`, staged to `deploy/wallet`    |
| `veylo-srv`    | `https://veylo-srv.vercel.app`    | The API (one Vercel Function, Node 24, region `iad1`) and the two cron routes               | `apps/api/build-vercel.mjs`, staged to `deploy/api` |

The names the brief asked for were taken by other people (`veylo` and `veylo-api` answer from someone else's project; `veylo-app` is taken and paused), so the shortest free close variants are used. No team-scoped or hash-addressed URL appears anywhere in the app, the README or these docs: those URLs sit behind Vercel's login and would also change on every deploy. `vercel.app` is on the Public Suffix List.

**Why the web app forwards `/api`.** `vercel.app` is on the Public Suffix List, so `veylopay.vercel.app` and `veylo-srv.vercel.app` are different _sites_ to a browser (L23 wants the web app and the API on one site). The API's sign-in cookie (`httpOnly`, `Secure`, `SameSite=Lax`, host-only) would not be sent back on a request from one to the other. So the web project's `vercel.json` has exactly one rewrite, `/api/:path*` to `https://veylo-srv.vercel.app/:path*`; the browser only ever talks to `https://veylopay.vercel.app`, and the cookie belongs to that origin. The API is still its own project with its own origin and still allows CORS only from the web origin (`WEB_ORIGIN`). The web app's API client puts `/api` in front of every path (`NEXT_PUBLIC_API_BASE_PATH`), refuses a path that climbs out of it, and the build fails if the rewrite points anywhere but the API origin. A custom domain would let you drop the rewrite: set `NEXT_PUBLIC_API_ORIGIN` to the API's own origin, leave `NEXT_PUBLIC_API_BASE_PATH` unset and delete the rewrite, with web and API as two subdomains of one registrable domain (section 8).

**Client IP (L26), measured on the live deployment on 2026-11-13** with the section 7 steps (`LOG_CLIENT_IP=true` for the check, then removed). The hop count is **1**, the same for a request straight to the API and for one through the web project's `/api` rewrite:

- With `TRUST_PROXY_HOPS=0` every request resolved to `127.0.0.1`: the only address the function sees directly is the platform's local launcher, so all clients would share one rate-limit bucket.
- With `TRUST_PROXY_HOPS=1` both paths resolved to the real client IP, and a request carrying a forged `X-Forwarded-For: 203.0.113.7` still resolved to the real IP (Vercel's edge replaces the header; the forged value never reaches the rate limiter).
- Two clients on different networks (this computer, and a throwaway function in another region, deleted afterwards) resolved to two different IPs on the same function instance. After the first client had used its ten sign-in attempts and was refused (429) on the eleventh, even while changing a forged `X-Forwarded-For` on every attempt, the second client still got its own ten and was refused on its eleventh.

`TRUST_PROXY_HOPS=1` stays. Re-do the check if the request path changes (for example a custom domain in front, or the rewrite removed). **A known limit:** the rate limiter keeps its counts in the function instance's memory, so separate instances each count on their own and a determined client could get a few times the limit. A shared store (Postgres or Redis) would fix that; it is not built.

### What changed from the long-running server

| Long-running (sections 1 to 10) | On Vercel                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api` service, `server.js`      | `apps/api/src/vercel.ts`: the same `buildServer` routes behind `(req, res)`, built once per instance. No route changed.                                                                                        |
| `worker:settlement` (pg-boss)   | Vercel Cron calls two internal routes (below), and a status page refreshes its own organisation's payouts when it is opened. The pg-boss worker is not deployed. The sweeps are the same idempotent functions. |
| Pre-deploy `pnpm db:migrate`    | Run from your computer against Neon's unpooled URL (below).                                                                                                                                                    |
| `/ready`                        | Same route. It answers 200 only when the database answers and no migration is pending.                                                                                                                         |

The function bundles every dependency into one file (a function has no install step) and is deployed prebuilt, so Vercel runs exactly the bundle that was built and tested here. A setting that is missing or invalid makes every route answer `503 NOT_CONFIGURED` and logs the variable _names_ that are wrong (never a value); `vercel logs` shows them.

### Cron jobs (and the plan limit)

Vercel Cron calls `GET` on a path with `Authorization: Bearer <CRON_SECRET>` when the project has a `CRON_SECRET` variable. Both routes check it in constant time on every call and answer `401` to anything else, before any work starts; they are not served at all if `CRON_SECRET` is unset. Neither job can quote, sign or submit anything new (`apps/api/src/hosted.test.ts` reads the source and fails if either could): settlement only follows up payloads a treasury wallet already signed, and the draft job gets a database and a clock only (D1).

| Path                            | Schedule (UTC) | Does                                                                                                                                         |
| ------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `/internal/cron/prepare-drafts` | `0 5 * * *`    | Prepares the draft pay run three days before each payday and marks it "Ready for review". Idempotent: one draft per organisation and payday. |
| `/internal/cron/settlement`     | `0 4 * * *`    | The five settlement sweeps for every organisation: poll payout status, resolve uncertain submits, expire quotes, reconcile, release holds.   |

**Plan limit.** On the Hobby plan a cron job runs at most once a day, with hourly precision (the job may run at any time within the hour) ([Cron jobs usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing), read 2026-11-13). A function may run for up to 300 seconds on Hobby ([Functions limits](https://vercel.com/docs/functions/limitations), read 2026-11-13); the API function is built with `maxDuration` 120 s, and the settlement cron starts no new row after 60 s of its own work. One row can make two 1Click calls at a 15 s timeout each plus a token refresh, about 45 s at worst, and a sweep checks the clock before every row and never inside one, so 60 s plus 45 s plus a 15 s margin fits inside 120 s. Both numbers live in `apps/api/src/function-limits.mjs`, and `apps/api/src/hosted.test.ts` builds the deployment and fails if the cutoff reaches the limit or leaves less than that room. A row cut off this way is picked up by the next run or the next page that refreshes it. Because payouts settle in seconds and a daily sweep is too slow to show them, **the pages that show payout status refresh on demand**: opening a pay run, the pay-run list, the ledger, a payslip, the treasury balances or a contractor's payslips first runs the same five sweeps for _that organisation only_, for at most 8 seconds and at most once every 10 seconds, and then reads. A refresh that fails or runs out of time just reads what is stored. The daily settlement cron is the backstop. On a paid plan the schedules in `apps/api/build-vercel.mjs` can be made as frequent as needed (for example every minute for `settlement`).

### Database (Neon through the Vercel Marketplace)

One Postgres database, region `iad1` (Neon `aws-us-east-1`), next to the function, on Neon's free plan, with Neon Auth off (Veylo has its own sign-in). The integration provides `DATABASE_URL` (the pooled URL) and `DATABASE_URL_UNPOOLED` to the `veylo-srv` project.

**Done 2026-11-13.** Installing it needed one thing only you can do: accept the Marketplace and Neon terms in a browser and finish the sign-up there (accepting the terms alone is not enough: the install step on that page creates the Neon installation, and until it exists the CLI answers `integration_terms_acceptance_required`). After that, one command does the rest and can be run again safely:

```
node tools/verify/src/finish-database.mjs
```

It installs Neon only if it is not already connected (a second install would create a second, unconnected database), checks that `DATABASE_URL` and `DATABASE_URL_UNPOOLED` are set on the API project, pulls them into a temporary folder for one command and deletes them, runs `pnpm build` and `pnpm db:migrate` (migrations 0001 to 0017) against the **unpooled** URL (a migration needs a real session, not a pooler), redeploys the API, and checks `https://veylopay.vercel.app/api/ready` answers `{"status":"ready"}`. It never prints a connection string.

The install command it runs, if it has to:

```
vercel integration add neon --cwd deploy/api --name veylo-db -m region=iad1 -m auth=false -e production --no-env-pull --plan free_v3
```

**A stray store to delete.** Running that command a second time while the first had already finished created a second, empty, unconnected Neon database also called `veylo-db` (`vercel storage list` shows it as "not connected"). The deployment does not use it. Delete it in the Vercel dashboard, Storage (the CLI's `vercel storage delete` needs an interactive confirmation).

### Variables per project (names only; never a value in this repository)

**`veylo-srv` (the API).** Set with `vercel env add NAME production --cwd deploy/api`. The tables in section 3 (`api`) say what each means.

| Name                     | Set by                                                                                           | Value / source                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Neon integration                                                                                 | The pooled connection URL. **Secret.**                                                                                                                                                       |
| `DATABASE_URL_UNPOOLED`  | Neon integration                                                                                 | Used only from your computer for migrations. **Secret.**                                                                                                                                     |
| `SESSION_ENCRYPTION_KEY` | Generated on the build machine and piped straight into Vercel, never printed (stored write-only) | 32 random bytes, base64. **Secret.** Rotation: see below.                                                                                                                                    |
| `CRON_SECRET`            | Generated the same way                                                                           | 32 random bytes, hex. **Secret.** Vercel Cron sends it.                                                                                                                                      |
| `ONECLICK_PARTNER_KEY`   | **You**                                                                                          | The 1Click partner JWT, from the NEAR Intents Partner Dashboard (section 15). **Secret.** Optional: without it, live quotes say "Live quotes are not connected yet" and nothing else breaks. |
| `NODE_ENV`               | Set                                                                                              | `production`                                                                                                                                                                                 |
| `LOG_LEVEL`              | Set                                                                                              | `info`                                                                                                                                                                                       |
| `WEB_ORIGIN`             | Set                                                                                              | `https://veylopay.vercel.app` (the only origin CORS allows)                                                                                                                                  |
| `AUTH_RECIPIENT`         | Set                                                                                              | `veylopay.vercel.app`, the same value the web build uses as `NEXT_PUBLIC_AUTH_RECIPIENT`                                                                                                     |
| `TRUST_PROXY_HOPS`       | Set                                                                                              | `1`                                                                                                                                                                                          |

The one command only you can run (the key is yours, from the Partner Dashboard; paste it at the prompt, so it never appears in your shell history or a log):

```
vercel env add ONECLICK_PARTNER_KEY production --sensitive --cwd deploy/api
vercel deploy --prebuilt --prod --cwd deploy/api
```

Variable changes apply to the next deployment, so redeploy after each one.

**`veylopay` (the web app), build-time and public by design (never a secret):**

| Name                                        | Required | Value                                                                                                                                                                        |
| ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_ORIGIN`                    | Yes      | `https://veylopay.vercel.app`, the web app's own origin, because `/api` is forwarded to the API (above)                                                                      |
| `NEXT_PUBLIC_API_BASE_PATH`                 | Yes      | `/api`                                                                                                                                                                       |
| `NEXT_PUBLIC_WALLET_BRIDGE_ORIGIN`          | Yes      | `https://veylo-wallet.vercel.app`. Never the API origin.                                                                                                                     |
| `NEXT_PUBLIC_AUTH_RECIPIENT`                | Yes      | `veylopay.vercel.app`. Same value as `AUTH_RECIPIENT` on the API.                                                                                                            |
| `NEXT_PUBLIC_SITE_ORIGIN`                   | Yes      | `https://veylopay.vercel.app`                                                                                                                                                |
| `NEXT_PUBLIC_NEAR_RPC_URL`                  | No       | Default `https://rpc.fastnear.com`                                                                                                                                           |
| `NEXT_PUBLIC_NEAR_ARCHIVAL_RPC_URL`         | No       | Default `https://archival-rpc.mainnet.fastnear.com`. Read-only, for the proof and verify pages.                                                                              |
| `NEXT_PUBLIC_PAYOUT_QUOTE_DEADLINE_MINUTES` | No       | Default 15. Same value as `PAYOUT_QUOTE_DEADLINE_MINUTES` on the API.                                                                                                        |
| `NEXT_PUBLIC_DEMO`                          | No       | `1` only for the in-browser demo build (`build:demo`, which `pnpm demo` uses). Leave it unset on the real app: `pnpm verify` fails a production build that carries the demo. |

**`veylo-wallet` (the bridge), build-time:**

| Name                       | Required | Value                                                                                |
| -------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `BRIDGE_APP_ORIGIN`        | Yes      | `https://veylopay.vercel.app`: the only origin allowed to frame the bridge           |
| `NEXT_PUBLIC_API_ORIGIN`   | Yes      | `https://veylo-srv.vercel.app`, read only to refuse a build whose CSP could reach it |
| `NEXT_PUBLIC_NEAR_RPC_URL` | No       | Default `https://rpc.fastnear.com`                                                   |
| `BRIDGE_CONNECT_ORIGINS`   | No       | Extra wallet hosts for `connect-src`. Leave unset unless a wallet needs one.         |
| `BRIDGE_IMG_ORIGINS`       | No       | Extra image hosts. Leave unset unless a wallet needs one.                            |

`scripts/verify-build.mjs` with `VEYLO_HOSTED=1` sets all of these from three values, `VEYLO_WEB_ORIGIN`, `VEYLO_BRIDGE_ORIGIN` and `VEYLO_API_ORIGIN`, so none of them is set on the Vercel projects themselves: the static sites are built here and uploaded.

### Before the first deploy

1. `design/images/LICENSES.md` exists and names every photo (the web build stops without it). **It does not exist yet: the photo licences are a founder task. The live site was built with a placeholder file saying so, and serves it at `/img/LICENSES.md`.** Write the real one, rebuild and redeploy.
2. `pnpm install --frozen-lockfile`, then `pnpm verify` passes from a clean install.
3. `pnpm demo` passes on the machine that builds.
4. The Postgres job passes: `pnpm build`, `pnpm db:migrate`, `pnpm test:pg`.
5. The three projects exist and are linked: `vercel link --yes --project veylo-srv --cwd deploy/api` (and `veylopay` for `deploy/web`, `veylo-wallet` for `deploy/wallet`). `deploy/` is git-ignored.
6. The variables above are set on `veylo-srv`, and no secret is in this repository or in a log.

### Build and deploy (exact steps)

From the repository root, with the Vercel CLI logged in (`vercel whoami`). Never hand the CLI a token on the command line or paste one anywhere.

```
# API: bundle the function, then deploy the prebuilt output
node apps/api/build-vercel.mjs
vercel deploy --prebuilt --prod --cwd deploy/api

# Web app and wallet bridge: build with the real origins (this also runs the production checks),
# stage both, check exactly what will be uploaded, deploy each
export VEYLO_HOSTED=1 VEYLO_WEB_ORIGIN=https://veylopay.vercel.app \
  VEYLO_BRIDGE_ORIGIN=https://veylo-wallet.vercel.app VEYLO_API_ORIGIN=https://veylo-srv.vercel.app
node apps/web/scripts/verify-build.mjs
node apps/web/scripts/stage-hosted.mjs
VEYLO_WEB_DIR=deploy/web VEYLO_BRIDGE_DIR=deploy/wallet node apps/web/scripts/verify-build.mjs --check-only
vercel deploy --prod --cwd deploy/web
vercel deploy --prod --cwd deploy/wallet
```

`verify-build.mjs` fails the build if any page or bridge file names a local, placeholder or team-scoped URL, if the demo world or the old demo banner is in it, if an inline script is not pinned by hash, if a wallet's page does not carry its reviewed policy, if a pinned executor's hash is wrong, or if the web project's rewrite points anywhere but the API origin.

### Redeploy, roll back, rotate

- **Redeploy** one project: repeat its lines above. A new deployment replaces the previous one at the same URL.
- **Roll back** the last deployment of a project: `vercel rollback --cwd deploy/<api|web|wallet>` (or promote an earlier deployment from the dashboard). Migrations only go forward: roll the API back only to a version that works with the current schema.
- **Rotate `CRON_SECRET`:** `vercel env rm CRON_SECRET production --cwd deploy/api`, add a new random value (`node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | vercel env add CRON_SECRET production --sensitive --cwd deploy/api`), redeploy the API. Nothing else uses it.
- **Rotate `ONECLICK_PARTNER_KEY`:** `vercel env rm` and `vercel env add ONECLICK_PARTNER_KEY production --sensitive --cwd deploy/api` with the new key from the Partner Dashboard, redeploy, check `/api/ready` and `/api/features` (`liveQuotes: true`).
- **Rotate `SESSION_ENCRYPTION_KEY`:** only when no payout is in flight (every pay run settled), because stored 1Click sessions and any signed payload awaiting resubmission are encrypted with it and become unreadable. Everyone then signs the 1Click session request again. `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | vercel env add SESSION_ENCRYPTION_KEY production --sensitive --cwd deploy/api` (after `vercel env rm`), then redeploy.
- **Rotate the database password:** in the Neon console (or the Vercel integration page). The integration updates `DATABASE_URL`; redeploy the API.

### After each deploy

1. `https://veylopay.vercel.app/api/ready` answers `{"status":"ready"}`.
2. Run the live checks (every route, the headers, CORS, cron refusal, sign-up and sign-in, tenant isolation, the file-by-file comparison with the staged build):

   ```
   LIVE_WEB=https://veylopay.vercel.app LIVE_BRIDGE=https://veylo-wallet.vercel.app LIVE_API=https://veylo-srv.vercel.app \
   LIVE_STAGED=deploy LIVE_OUT=<an empty folder outside the repository> pnpm exec tsx tools/verify/src/live-check.ts
   ```

   It creates throwaway accounts and two organisations named "W7 live check" (no funds, no transactions).

3. The browser checks (all pages at 390 and 1440 px with axe, the wallet picker with each executor's hash, storage and message isolation between the app and bridge origins):

   ```
   LIVE_WEB=... LIVE_BRIDGE=... LIVE_SESSION=<LIVE_OUT>/live-session.json node apps/web/scripts/live-browser.mjs all
   ```

4. Lighthouse, mobile, five runs, floor 85 (L47): `LIVE_URL=https://veylopay.vercel.app LH_THROUGH_PROXY=1 node apps/web/scripts/lighthouse-live.mjs`. Chrome 157 with Lighthouse 13.5 loses the navigation start when the page sends `Cross-Origin-Opener-Policy`, so the runs go through a pass-through proxy on your computer that forwards everything to the live host and drops only that response header.
5. `pnpm demo` still exits 0, and the section 10 and section 12 checklists hold.
6. Note the date. Do this again on 2026-11-16, when judging starts, and on 2026-11-25.

### Things that stay as they are, on purpose

- **No email is sent.** There is no provider (section 16). Where an email would be sent, the app says "Email delivery is not set up yet" and does not pretend; the owner copies a contractor's invite link and sends it themselves.
- **Vercel's toolbar is off for all three projects** (`enableProductionFeedback` and `enablePreviewFeedback` set to `false` through the project settings API, `vercel api /v9/projects/<name> -X PATCH -F enableProductionFeedback=false -F enablePreviewFeedback=false`). While it was on, Vercel appended a small snippet to one script of the web project (inert without a `__vercel_toolbar=1` cookie, but a browser that carried that cookie, such as the team owner's, tried to load `vercel.live`, which the app's CSP refuses, and logged console errors). The live check now requires every served file to be the staged file byte for byte.
- **The agents worker** is never deployed (L46, section 9).

## 15. The 1Click partner key (`ONECLICK_PARTNER_KEY`)

Veylo quotes and settles every payout and every funding conversion through the 1Click API of NEAR Intents. The partner JWT for that API is held in exactly one variable.

| Item            | Value                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Variable        | `ONECLICK_PARTNER_KEY` (secret)                                                                                                                                                                                                           |
| Set on          | `api` and `worker:settlement` only (section 3). Never on the web app, the wallet bridge or `migrate`. Never in this repository, a log or a chat.                                                                                          |
| Where to get it | The NEAR Intents Partner Dashboard, https://partners.near-intents.org/home, as described in the official [API Keys page](https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md) (read 2026-11-12). |
| How it is sent  | As the `X-API-Key` header on 1Click requests. The same docs say `Authorization: Bearer` is also accepted for the same JWT.                                                                                                                |
| Without it      | The docs say unauthenticated requests pay an extra 0.25% platform fee on every non-`ANY_INPUT` quote, while authenticated requests use the partner fee schedule (typically 20 bps, or 1 bp on stablecoin and same-asset routes).          |

Which features need it:

- **Funding needs no key (W7.3).** A funding quote (the one-time deposit address a company sends USDC to) and the status of the deposit it was quoted for are the two calls 1Click serves without a key; they are the only calls the API makes keyless, the quote is still signed and still checked in the browser (gate F), and the extra 0.25% fee above applies. `GET /features` reports `fundingQuotes: true` either way. How to fund today, with the sources: `docs/FUNDING.md`.
- **Every other quote:** payout quotes and the signed-intent payload and submit calls. Without the key the API and the settlement sweeps still start, but every one of these is refused with the same plain sentence, "Live quotes are not connected yet" (`LIVE_QUOTES_OFF`, HTTP 503; an address check shows it as its reason), and nothing is sent to 1Click, so nothing but funding runs unauthenticated. `GET /features` reports `liveQuotes: false` and the pay-run screen says so. Everything that does not quote still works: sign-in, organisations, contractors, pay-run drafts and review, the ledger, the privacy proof and the verify page.
- **Settlement status checks** in the worker.
- **`pnpm verify` step 11.3 (dry 1Click quotes).** With no key in the environment the step is skipped, and the report says `SKIPPED ... no partner key (ONECLICK_PARTNER_KEY)`. It never fails because the key is missing, and it never prints the key.
- **Not needed:** the demo (`pnpm demo`, `pnpm dev:web`), the browser checks, the privacy proof and the verify page (they read NEAR RPC only), the unit and database tests, and `pnpm dev:wallet` for sign-in.

If the key is rotated in the Partner Dashboard, set the new value on `api` and `worker:settlement` together, restart both, and check `GET /ready`.

## 16. Email delivery (not built yet; the deployed app says so)

Veylo has email accounts (sign-up, confirmation, password reset, contractor invitations). The API writes each message to the `email_outbox` table, and **nothing sends it yet**: no email provider is chosen (founder decision, see [DECISIONS.md](../DECISIONS.md)). Until one is wired, a real person doesn't receive the confirmation link, the reset link or an invitation.

What the founder needs to decide and set up:

- **A provider** that sends transactional email, and a sending domain with SPF, DKIM and DMARC set. Veylo does not name one here.
- **A sender job** (in `worker:settlement`, or a small worker of its own) that reads rows with `delivered_at IS NULL`, sends them, and sets `delivered_at`. It would hold the provider's API key as a secret on that process only (never the web app, the bridge or `migrate`).
- **Retention.** Each row's body holds a single-use link (a confirmation link lasts 24 hours, a reset link 1 hour). Treat the table as sensitive: delete delivered rows after a short time. A purge is not built yet.

Until then, the local demo and the tests read the outbox directly. The deployed app never claims an email was sent: `GET /features` reports `emailDelivery: false`, and wherever an email would have been sent the screen says "Email delivery is not set up yet" (sign-up, the confirmation notice, forgot password, the contractor invite). The owner copies a contractor's invite link and sends it themselves. Turning email on later means a provider, a sender job and `emailDelivery: true` in `apps/api/src/vercel.ts`.

## 17. Exchange rates for local-currency estimates

Local-currency estimates (NGN, EUR, GBP, KES, INR and others) are display only. The API fetches one public rate list, `https://open.er-api.com/v6/latest/USD` (ExchangeRate-API's open access endpoint), caches it for up to one hour, and serves it to signed-in users at `GET /fx`. When the source can't be reached the answer is "unavailable" and every screen says "rate unavailable"; nothing is guessed.

- **No key and no variable.** The endpoint needs no account. The screens show the source's required attribution and a link to its terms.
- **Only the API contacts it.** The browser never does (the web app's CSP has no entry for it).
- **Never in a payment.** The rates are not used to work out, quote, sign or settle anything; a test reads the source of every payout path and fails if one imports the rate code.
