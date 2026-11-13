# Deploy runbook

How Veylo's backend runs in production, and what to check at each deploy. Decisions: L23 (same-site
web and API), L24 (built JS in production), L26 (proxy check), L31 and L36 (key separation), L37
(build, readiness, shutdown), L38 (per-process config, worker migration guard, client-IP logging).

Railway behaviour stated here cites the Railway docs page it comes from, fetched 2026-11-07. Anything
not confirmed from a fetched page is marked **(unverified)**.

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
14. Hosted demo: services, checklist and variables per service
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
| `ONECLICK_PARTNER_KEY`            | **Secret**                      | Yes        | 1Click partner JWT                                                                                                |
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

| Name                        | Secret                          | Required | Notes                              |
| --------------------------- | ------------------------------- | -------- | ---------------------------------- |
| `DATABASE_URL`              | **Secret** (holds the password) | Yes      | Same database as `api`             |
| `ONECLICK_PARTNER_KEY`      | **Secret**                      | Yes      | Same value as `api`                |
| `SESSION_ENCRYPTION_KEY`    | **Secret**                      | Yes      | Same value as `api` (L36)          |
| `NODE_ENV`                  | No                              | Yes      | `production`                       |
| `LOG_LEVEL`                 | No                              | Yes      | `info`                             |
| `NEAR_RPC_URL`              | No                              | No       | Default `https://rpc.fastnear.com` |
| `ONECLICK_QUOTE_PUBLIC_KEY` | No                              | No       | Default: the key pinned in S-C     |

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
- **Web and wallet bridge on Vercel**: built (sections 12 and 14), not deployed yet. They wait for the founder to say go.

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

- Every page shows a **Demo data** banner. The people and amounts are made up. They are the same test data the browser checks use (`apps/web/scripts/demo-data.mjs`).
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

## 14. Hosted demo: services, checklist and variables per service

**Keep the hosted demo up until at least 2026-11-25.** NEAR HACKATHON judging starts 2026-11-16, and the organisers answer to Q-012 is that a working demo must stay available to 2026-11-18 and, ideally, to 2026-11-25. If a host would take it down earlier (a trial ending, a free-tier limit), move it before then. The hosted demo runs on the services below. It is a deploy, so nothing in this section has been done: it waits for the founder to say go.

| Service             | Host    | Runs                                                    | Needs                                    |
| ------------------- | ------- | ------------------------------------------------------- | ---------------------------------------- |
| `web`               | Vercel  | The static app (`apps/web/out/`)                        | The API origin and the bridge origin     |
| `wallet bridge`     | Vercel  | The static bridge (`apps/web/out-bridge/`), own project | The app origin                           |
| `api`               | Railway | `pnpm start`                                            | Postgres, the 1Click key, the web origin |
| `worker:settlement` | Railway | `pnpm worker:settlement`                                | The same Postgres and keys as `api`      |
| Postgres            | Railway | Postgres 17                                             | Private network only                     |

### Before the first deploy

1. `design/images/LICENSES.md` exists and names every photo (the web build stops without it).
2. `pnpm install --frozen-lockfile`, then `pnpm verify` passes from a clean install.
3. `pnpm demo` passes on the machine that builds.
4. The Postgres job passes: `pnpm build`, `pnpm db:migrate`, `pnpm test:pg`.
5. The domains are set up as in section 8: the web app, the API and the bridge each have their own origin, and the web app and API are same-site.
6. Section 7 (proxy check) is planned for the first deploy.
7. Every variable below is set on its service, and no secret is in this repository or in a log.
8. `pnpm dev:wallet` (section 13) has been done once by the founder, with Meteor, against a local database.
9. The founder has approved the deploy. Nothing here deploys itself.

### Variables per service (names only)

**`api`** and **`worker:settlement`**: the tables in section 3. The worker prepares scheduled drafts (it never quotes, signs or submits), so it needs no extra variable. The reminder email hook is switched off in code and has no variable.

**`migrate`** (pre-deploy): `DATABASE_URL`. Section 3.

**`web`** (set on the Vercel project; build-time, public by design, never a secret):

| Name                                        | Required | Notes                                                                                                                                                |
| ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_ORIGIN`                    | Yes      | The API origin, no path (section 8)                                                                                                                  |
| `NEXT_PUBLIC_WALLET_BRIDGE_ORIGIN`          | Yes      | The bridge origin, e.g. `https://wallet.<domain>`. Never the API origin.                                                                             |
| `NEXT_PUBLIC_AUTH_RECIPIENT`                | Yes      | Same value as `AUTH_RECIPIENT` on `api`                                                                                                              |
| `NEXT_PUBLIC_NEAR_RPC_URL`                  | No       | Default `https://rpc.fastnear.com`                                                                                                                   |
| `NEXT_PUBLIC_NEAR_ARCHIVAL_RPC_URL`         | No       | Default `https://archival-rpc.mainnet.fastnear.com`. Read-only, for the proof and verify pages.                                                      |
| `NEXT_PUBLIC_PAYOUT_QUOTE_DEADLINE_MINUTES` | No       | Default 15. Same value as `PAYOUT_QUOTE_DEADLINE_MINUTES` on `api`.                                                                                  |
| `NEXT_PUBLIC_SITE_ORIGIN`                   | Yes      | The public site origin, for page metadata                                                                                                            |
| `NEXT_PUBLIC_DEMO`                          | No       | `1` only for the in-browser demo build (`build:demo`). Leave it unset on the real app: `pnpm verify` fails a production build that carries the demo. |

**`wallet bridge`** (build-time variables on its own Vercel project):

| Name                       | Required | Notes                                                                        |
| -------------------------- | -------- | ---------------------------------------------------------------------------- |
| `BRIDGE_APP_ORIGIN`        | Yes      | The web app origin: the only origin allowed to frame the bridge              |
| `NEXT_PUBLIC_API_ORIGIN`   | Yes      | Read only to refuse a build whose CSP would reach the API (section 12)       |
| `NEXT_PUBLIC_NEAR_RPC_URL` | No       | Default `https://rpc.fastnear.com`                                           |
| `BRIDGE_CONNECT_ORIGINS`   | No       | Extra wallet hosts for `connect-src`. Leave unset unless a wallet needs one. |
| `BRIDGE_IMG_ORIGINS`       | No       | Extra image hosts. Leave unset unless a wallet needs one.                    |

**Postgres:** no variables of its own. Railway gives `api`, `worker:settlement` and `migrate` the private URL as `DATABASE_URL` (section 3).

### After each deploy

Run the section 10 checklist and the section 12 bridge checks. Then open the hosted demo link, go through the six rows of the README Judge quickstart, and note the date. Do this again on 2026-11-16, when judging starts, and on 2026-11-25.

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

- **Every quote:** payout quotes, funding quotes (USDC from other chains, NEAR and USDT conversions), and the signed-intent payload and submit calls. The API and the settlement worker refuse to start without it (section 3), so nothing runs unauthenticated by accident.
- **Settlement status checks** in the worker.
- **`pnpm verify` step 11.3 (dry 1Click quotes).** With no key in the environment the step is skipped, and the report says `SKIPPED ... no partner key (ONECLICK_PARTNER_KEY)`. It never fails because the key is missing, and it never prints the key.
- **Not needed:** the demo (`pnpm demo`, `pnpm dev:web`), the browser checks, the privacy proof and the verify page (they read NEAR RPC only), the unit and database tests, and `pnpm dev:wallet` for sign-in.

If the key is rotated in the Partner Dashboard, set the new value on `api` and `worker:settlement` together, restart both, and check `GET /ready`.

## 16. Email delivery (not built yet)

Veylo has email accounts (sign-up, confirmation, password reset, contractor invitations). The API writes each message to the `email_outbox` table, and **nothing sends it yet**: no email provider is chosen (founder decision, see [DECISIONS.md](../DECISIONS.md)). Until one is wired, a real person doesn't receive the confirmation link, the reset link or an invitation.

What the founder needs to decide and set up:

- **A provider** that sends transactional email, and a sending domain with SPF, DKIM and DMARC set. Veylo does not name one here.
- **A sender job** (in `worker:settlement`, or a small worker of its own) that reads rows with `delivered_at IS NULL`, sends them, and sets `delivered_at`. It would hold the provider's API key as a secret on that process only (never the web app, the bridge or `migrate`).
- **Retention.** Each row's body holds a single-use link (a confirmation link lasts 24 hours, a reset link 1 hour). Treat the table as sensitive: delete delivered rows after a short time. A purge is not built yet.

Until then, the local demo and the tests read the outbox directly. The sign-up screens say "check your email", so the hosted demo must not be mistaken for a working email flow.

## 17. Exchange rates for local-currency estimates

Local-currency estimates (NGN, EUR, GBP, KES, INR and others) are display only. The API fetches one public rate list, `https://open.er-api.com/v6/latest/USD` (ExchangeRate-API's open access endpoint), caches it for up to one hour, and serves it to signed-in users at `GET /fx`. When the source can't be reached the answer is "unavailable" and every screen says "rate unavailable"; nothing is guessed.

- **No key and no variable.** The endpoint needs no account. The screens show the source's required attribution and a link to its terms.
- **Only the API contacts it.** The browser never does (the web app's CSP has no entry for it).
- **Never in a payment.** The rates are not used to work out, quote, sign or settle anything; a test reads the source of every payout path and fails if one imports the rate code.
