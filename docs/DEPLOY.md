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

## 1. Services

| Service             | Host    | Runs                                                      | Public                                               |
| ------------------- | ------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `api`               | Railway | `node apps/api/dist/bin/server.js`                        | Yes, only through Railway's proxy, on the API domain |
| `worker:settlement` | Railway | `node apps/api/dist/bin/worker.js`                        | No. It opens no port.                                |
| Postgres            | Railway | Postgres 17 (CI tests 17.11)                              | No. Private network only.                            |
| `web`               | Vercel  | Not built yet (UI slices await Phase 4 design references) | Yes, later                                           |

The agents worker is not deployed (section 9).

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

### `worker:agents` (not deployed until slice 8)

| Name                   | Secret                          | Required | Notes                                              |
| ---------------------- | ------------------------------- | -------- | -------------------------------------------------- |
| `DATABASE_URL`         | **Secret** (holds the password) | Yes      |                                                    |
| `ONECLICK_PARTNER_KEY` | **Secret**                      | Yes      |                                                    |
| `NEARAI_API_KEY`       | **Secret**                      | Yes      | NEAR AI Cloud key                                  |
| `AGENT_KEY_MASTER_KEY` | **Secret**                      | Yes      | Agent keys only. Never on any other service (L31). |
| `NODE_ENV`             | No                              | Yes      | `production`                                       |
| `LOG_LEVEL`            | No                              | Yes      | `info`                                             |

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

- **Agents worker** (`node apps/api/dist/bin/worker-agents.js`): not deployed until slice 8. It has no
  jobs; it checks migrations and exits. Its variables are in section 3, and it never gets
  `SESSION_ENCRYPTION_KEY` (L31, L36).
- **Web on Vercel**: later, after the UI slices.

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
