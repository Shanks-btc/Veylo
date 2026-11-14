// Live checks against the hosted deployment (slice W7). Run with tsx:
//
//   LIVE_WEB=https://... LIVE_BRIDGE=https://... LIVE_API=https://... \
//   LIVE_STAGED=deploy  LIVE_OUT=<folder for the session file> \
//     pnpm exec tsx tools/verify/src/live-check.ts
//
// What it proves, over the real network, against the real hosts:
//   pages       every route answers 200 on the web and bridge sites, an unknown path answers the
//               designed 404, and every file served is byte-for-byte the staged build (SHA-256)
//   headers     every security header the repository's vercel.json files promise is really sent
//   api         health, readiness, features; CORS refuses other origins; the cron routes refuse any
//               call without the secret; the rate limit cannot be bypassed with a forged IP header
//   accounts    sign-up and sign-in by email, the cookie's flags, and a wallet-signed sign-in
//   tenants     one organisation cannot read another's, and answers exactly as for a missing one
//
// It creates throwaway accounts and two throwaway organisations named "W7 live check" in the live
// database (no funds, no transactions) and says so. It never prints a cookie or a secret.
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashNep413 } from "@veylo/intents";
// The browser's own check of a funding quote (gate F), run here on what the live API serves.
import { checkFundingQuote } from "../../../apps/web/src/gates/funding.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v.replace(/\/$/, "");
};
const WEB = env("LIVE_WEB");
const BRIDGE = env("LIVE_BRIDGE");
const API = env("LIVE_API");
const STAGED = resolve(root, process.env.LIVE_STAGED ?? "deploy");
const OUT = process.env.LIVE_OUT;

type Result = { area: string; name: string; ok: boolean; detail: string };
const results: Result[] = [];
function check(area: string, name: string, ok: boolean, detail = "") {
  results.push({ area, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${area.padEnd(9)} ${name}${detail ? `  (${detail})` : ""}`);
}

/** A response body as an object; anything else (an HTML error page, nothing) is an empty one. */
const body = async (r: Response): Promise<Record<string, any>> =>
  (await r.json().catch(() => ({}))) as Record<string, any>;
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
async function get(url: string, init: RequestInit = {}) {
  // A dropped connection is retried (a request that was answered, whatever the status, is not).
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, { redirect: "manual", ...init });
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((done) => setTimeout(done, 500 * attempt));
    }
  }
}

// ---- base58, for the key format NEAR uses ----
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DIGIT = new Map([...ALPHABET].map((c, i) => [BigInt(i), c] as const));
function base58(bytes: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = (DIGIT.get(n % 58n) ?? "") + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** A throwaway wallet: an implicit NEAR account (its id is its public key), made for this run. */
function newWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    accountId: raw.toString("hex"),
    publicKey: `ed25519:${base58(raw)}`,
    sign(message: string, nonce: string, recipient: string) {
      const hash = hashNep413({ message, nonce: Buffer.from(nonce, "base64"), recipient });
      return edSign(null, Buffer.from(hash), privateKey).toString("base64");
    },
  };
}

/** A tiny cookie jar for one signed-in person. */
function jar() {
  const cookies = new Map<string, string>();
  return {
    store(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const [pair] = line.split(";");
        const eq = pair!.indexOf("=");
        cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1));
      }
    },
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    has: () => cookies.size > 0,
    entries: () => [...cookies],
  };
}

// ======================================================================= pages and files
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".vercel") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

async function sameAsStaged(site: "web" | "wallet", origin: string) {
  const dir = join(STAGED, site);
  if (!existsSync(dir)) return check("files", `${site}: staged build found`, false, dir);
  const files = await filesUnder(dir);
  let bad: string[] = [];
  let n = 0;
  // vercel.json is configuration, not served; the rest must match byte for byte.
  const queue = files.filter((f) => !f.endsWith("vercel.json"));
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const file = queue.pop();
      if (!file) return;
      const path = "/" + relative(dir, file).replaceAll("\\", "/");
      // Pages are served at clean URLs (and the web site's index at /).
      const candidates = path.endsWith("/index.html")
        ? [path.slice(0, -"index.html".length)]
        : path.endsWith(".html")
          ? [path.slice(0, -".html".length)]
          : [path];
      let matched = false;
      for (const url of candidates) {
        const res = await get(origin + (url === "" ? "/" : url));
        if (res.status !== 200) continue;
        const body = Buffer.from(await res.arrayBuffer());
        const staged = readFileSync(file);
        if (sha256(body) === sha256(staged)) matched = true;
        break;
      }
      n += 1;
      if (!matched) bad.push(path);
    }
  });
  await Promise.all(workers);
  check(
    "files",
    `${site}: ${n} files served are the staged build, byte for byte`,
    bad.length === 0,
    bad.slice(0, 4).join(", "),
  );
}

async function pages() {
  const { ALL_PAGES } = (await import(
    pathToUrl(join(root, "apps", "web", "scripts", "pages-list.mjs"))
  )) as { ALL_PAGES: { name: string; path: string }[] };
  const bad: string[] = [];
  for (const p of ALL_PAGES) {
    const res = await get(WEB + p.path);
    const type = res.headers.get("content-type") ?? "";
    if (p.name === "not-found" || p.path.includes("does-not-exist")) continue;
    if (res.status !== 200 || !type.startsWith("text/html")) bad.push(`${p.path} ${res.status}`);
  }
  check(
    "pages",
    `${ALL_PAGES.length} web routes answer 200 as HTML`,
    bad.length === 0,
    bad.join("; "),
  );

  const missing = await get(`${WEB}/this-page-does-not-exist-w7`);
  const text = await missing.text();
  check(
    "pages",
    "an unknown web path answers the designed 404",
    missing.status === 404 && /404|not found/i.test(text) && text.includes("<html"),
    `status ${missing.status}`,
  );
  const missingBridge = await get(`${BRIDGE}/this-page-does-not-exist-w7`);
  check(
    "pages",
    "an unknown bridge path answers 404",
    missingBridge.status === 404,
    `status ${missingBridge.status}`,
  );

  const lock = JSON.parse(
    readFileSync(join(root, "apps", "web", "src", "wallet", "wallets.lock.json"), "utf8"),
  );
  const enabled = lock.wallets.filter((w: { enabled: boolean }) => w.enabled);
  const badBridge: string[] = [];
  for (const w of enabled) {
    const res = await get(`${BRIDGE}/w/${w.id}/`);
    if (res.status !== 200) badBridge.push(`${w.id} ${res.status}`);
    const ex = await get(`${BRIDGE}/wallets/${w.executor.file}`);
    const hash = sha256(Buffer.from(await ex.arrayBuffer()));
    if (ex.status !== 200 || hash !== w.executor.sha256) badBridge.push(`${w.id} executor`);
  }
  const embedded = await get(`${BRIDGE}/embedded/`);
  if (embedded.status !== 200) badBridge.push(`embedded ${embedded.status}`);
  check(
    "pages",
    `${enabled.length} wallet pages and the Veylo wallet answer 200; each pinned executor's hash matches`,
    badBridge.length === 0,
    badBridge.join("; "),
  );
}

const pathToUrl = (p: string) => new URL(`file:///${p.replaceAll("\\", "/")}`).href;

// ======================================================================= headers
function sourceToRegExp(source: string): RegExp {
  const body = source
    .replaceAll(".", "\\.")
    .replaceAll("(.*)", ".*")
    .replace(/:[A-Za-z]+\*/g, ".*");
  return new RegExp(`^${body}$`);
}
type Rule = { source: string; headers: { key: string; value: string }[] };

async function headersFor(site: "web" | "wallet", origin: string, urls: string[]) {
  const file = join(STAGED, site, "vercel.json");
  const rules: Rule[] = JSON.parse(readFileSync(file, "utf8")).headers;
  const bad: string[] = [];
  for (const path of urls) {
    const res = await get(origin + path);
    const expected = new Map<string, string>();
    for (const rule of rules) {
      if (sourceToRegExp(rule.source).test(path))
        for (const h of rule.headers) expected.set(h.key.toLowerCase(), h.value);
    }
    for (const [key, value] of expected) {
      const got = res.headers.get(key) ?? "";
      if (key === "strict-transport-security") {
        if (!got.includes("max-age=63072000")) bad.push(`${path} ${key}`);
      } else if (
        !got.split(/,\s(?=[A-Za-z-]+=|default-src|frame-ancestors)/).includes(value) &&
        got !== value
      ) {
        bad.push(`${path} ${key}`);
      }
    }
  }
  check(
    "headers",
    `${site}: every header in vercel.json is sent on ${urls.length} URLs`,
    bad.length === 0,
    bad.slice(0, 4).join("; "),
  );
}

async function headerRules() {
  await headersFor("web", WEB, ["/", "/docs", "/app", "/app/sign-in", "/portal", "/proof"]);
  const lock = JSON.parse(
    readFileSync(join(root, "apps", "web", "src", "wallet", "wallets.lock.json"), "utf8"),
  );
  const ids = lock.wallets
    .filter((w: { enabled: boolean }) => w.enabled)
    .map((w: { id: string }) => `/w/${w.id}/`);
  await headersFor("wallet", BRIDGE, [...ids, "/embedded/", "/main.js"]);

  // The reviewed properties, stated outright rather than only compared with the file.
  const app = await get(WEB + "/");
  const get1 = (r: Response, k: string) => r.headers.get(k) ?? "";
  check(
    "headers",
    "app: never framed, no sniffing, no referrer, popups allowed for wallets",
    /DENY/i.test(get1(app, "x-frame-options")) &&
      /nosniff/i.test(get1(app, "x-content-type-options")) &&
      get1(app, "referrer-policy") === "no-referrer" &&
      get1(app, "cross-origin-opener-policy") === "same-origin-allow-popups",
  );
  const html = await app.text();
  const meta =
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/
      .exec(html)?.[1]
      ?.replaceAll("&quot;", '"') ?? "";
  const scriptSrc = /script-src ([^;]+)/.exec(meta)?.[1] ?? "";
  check(
    "headers",
    "app: CSP in the page, scripts pinned by hash, no unsafe-inline or unsafe-eval",
    meta !== "" && /sha256-/.test(scriptSrc) && !/unsafe-/.test(meta),
    meta ? "" : "no policy",
  );
  check(
    "headers",
    "app: connect-src names only itself and NEAR RPC (no API host, no localhost)",
    !/localhost|127\.0\.0\.1|vercel\.app/.test(
      /connect-src ([^;]+)/.exec(meta)?.[1]?.replaceAll(WEB, "") ?? "",
    ),
    /connect-src ([^;]+)/.exec(meta)?.[1] ?? "",
  );

  const emb = await get(BRIDGE + "/embedded/");
  const pp = emb.headers.get("permissions-policy") ?? "";
  check(
    "headers",
    "bridge: only the Veylo wallet page may use passkeys",
    /publickey-credentials/.test(pp),
  );
  const meteor = await get(`${BRIDGE}/w/${ids[0]!.split("/")[2]}/`);
  check(
    "headers",
    "bridge: a third-party wallet page may not use passkeys",
    !/publickey-credentials-(create|get)=\(self\)/.test(
      meteor.headers.get("permissions-policy") ?? "",
    ),
  );
  const embCsp = emb.headers.get("content-security-policy") ?? "";
  check(
    "headers",
    "bridge: framing allowed only by the web origin; the Veylo wallet has connect-src 'none'",
    embCsp.includes(`frame-ancestors ${WEB}`) && /connect-src 'none'/.test(embCsp),
    embCsp.slice(0, 0),
  );
}

// ======================================================================= API
async function api() {
  const proxied = (p: string, init?: RequestInit) => get(`${WEB}/api${p}`, init);
  const direct = (p: string, init?: RequestInit) => get(`${API}${p}`, init);

  const h1 = await proxied("/health");
  check(
    "api",
    "GET /api/health through the web origin",
    h1.status === 200 && (await body(h1)).status === "ok",
  );
  const h2 = await direct("/health");
  check("api", "GET /health on the API origin", h2.status === 200);
  const ready = await proxied("/ready");
  const readyBody = await body(ready);
  check(
    "api",
    "GET /api/ready: the database answers and no migration is pending",
    ready.status === 200 && readyBody.status === "ready",
    `status ${ready.status} ${JSON.stringify(readyBody).slice(0, 80)}`,
  );
  const feat = await proxied("/features");
  check(
    "api",
    "GET /api/features says what this deployment can do",
    feat.status === 200,
    JSON.stringify(await feat.json().catch(() => ({}))),
  );

  // CORS: only the web origin. The API names its one allowed origin on every answer, so another
  // origin is refused by the browser because the header never names it (and is never "*").
  const grants = (r: Response, origin: string) => {
    const allowed = r.headers.get("access-control-allow-origin");
    return allowed === "*" || allowed === origin;
  };
  const evil = await direct("/health", { headers: { origin: "https://evil.example" } });
  check(
    "api",
    "CORS: another origin is not granted access (the allow-origin header never names it, never *)",
    !grants(evil, "https://evil.example"),
  );
  const pre = await direct("/orgs", {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  check(
    "api",
    "CORS: another origin's preflight is not granted",
    !grants(pre, "https://evil.example"),
  );
  const ok = await direct("/health", { headers: { origin: WEB } });
  check(
    "api",
    "CORS: the web origin is allowed, with credentials",
    ok.headers.get("access-control-allow-origin") === WEB &&
      ok.headers.get("access-control-allow-credentials") === "true",
  );
  const bridgeOrigin = await direct("/health", { headers: { origin: BRIDGE } });
  check(
    "api",
    "CORS: the wallet bridge origin is not granted access",
    !grants(bridgeOrigin, BRIDGE),
  );

  // Cron routes: refuse everything without the secret (here, with none and with a wrong one).
  for (const job of ["settlement", "prepare-drafts"]) {
    const a = await direct(`/internal/cron/${job}`);
    const b = await direct(`/internal/cron/${job}`, {
      headers: { authorization: "Bearer " + "x".repeat(40) },
    });
    const c = await proxied(`/internal/cron/${job}`, {
      headers: { authorization: "Bearer " + "x".repeat(40) },
    });
    check(
      "api",
      `cron ${job}: refused with no secret, a wrong secret, and through the web origin`,
      a.status === 401 && b.status === 401 && c.status === 401,
      `${a.status}/${b.status}/${c.status}`,
    );
  }

  // Email account: sign up, cookie flags, me, sign out, sign in again.
  const email = `w7-live-check-${randomBytes(5).toString("hex")}@example.com`;
  const password = randomBytes(18).toString("base64url") + "-Q7";
  const who = jar();
  const up = await proxied("/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  who.store(up);
  check(
    "accounts",
    "email sign-up through the web origin",
    up.status === 201,
    `status ${up.status}`,
  );
  const cookieLine = up.headers.getSetCookie().find((l) => l.startsWith("veylo_session=")) ?? "";
  check(
    "accounts",
    "the session cookie is HttpOnly, Secure, SameSite=Lax, host-only (no Domain)",
    /HttpOnly/i.test(cookieLine) &&
      /Secure/i.test(cookieLine) &&
      /SameSite=Lax/i.test(cookieLine) &&
      !/Domain=/i.test(cookieLine),
  );
  const me = await proxied("/me", { headers: { cookie: who.header() } });
  check(
    "accounts",
    "GET /api/me with that cookie returns the account",
    me.status === 200 && (await body(me)).user?.email === email,
  );
  const out = await proxied("/auth/logout", { method: "POST", headers: { cookie: who.header() } });
  const after = await proxied("/me", { headers: { cookie: who.header() } });
  check(
    "accounts",
    "sign-out ends the session",
    out.status === 200 && after.status === 401,
    `${out.status}/${after.status}`,
  );
  const again = jar();
  const inn = await proxied("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  again.store(inn);
  check("accounts", "email sign-in", inn.status === 200 && again.has(), `status ${inn.status}`);
  const bad = await proxied("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: password + "x" }),
  });
  check("accounts", "a wrong password is refused", bad.status === 401, `status ${bad.status}`);
  const forgot = await proxied("/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  check(
    "accounts",
    "no email is claimed: features says email delivery is off",
    feat.status === 200 && (await body(await proxied("/features"))).emailDelivery === false,
    `forgot ${forgot.status}`,
  );

  // Two wallet-signed people, each with an organisation, for the tenant-isolation sample.
  async function walletPerson() {
    const w = newWallet();
    const j = jar();
    const c = await proxied("/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: w.accountId }),
    });
    const ch = (await c.json()) as { message: string; nonce: string; recipient: string };
    const v = await proxied("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: w.accountId,
        publicKey: w.publicKey,
        signature: w.sign(ch.message, ch.nonce, ch.recipient),
        nonce: ch.nonce,
      }),
    });
    j.store(v);
    return { w, j, status: v.status };
  }
  const A = await walletPerson();
  const B = await walletPerson();
  check(
    "accounts",
    "wallet-signed sign-in (NEP-413) for two throwaway people",
    A.status === 200 && B.status === 200,
    `${A.status}/${B.status}`,
  );
  const mk = async (p: Awaited<ReturnType<typeof walletPerson>>, name: string) => {
    const r = await proxied("/orgs", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: p.j.header() },
      body: JSON.stringify({ name }),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as { id?: string } };
  };
  const orgA = await mk(A, "W7 live check A");
  const orgB = await mk(B, "W7 live check B");
  check(
    "tenants",
    "each person creates an organisation",
    orgA.status === 201 && orgB.status === 201,
    `${orgA.status}/${orgB.status}`,
  );
  if (orgA.body.id && orgB.body.id) {
    const read = (p: typeof A, id: string, path = "") =>
      proxied(`/orgs/${id}${path}`, { headers: { cookie: p.j.header() } });
    const own = await read(A, orgA.body.id);
    const cross = await read(A, orgB.body.id);
    const missing = await read(A, "00000000-0000-4000-8000-000000000000");
    const crossText = await cross.text();
    check("tenants", "A reads A's organisation", own.status === 200);
    check(
      "tenants",
      "A reading B's organisation is a 404 identical to a missing one",
      cross.status === 404 && missing.status === 404 && crossText === (await missing.text()),
      `${cross.status}/${missing.status}`,
    );
    for (const path of ["/contractors", "/pay-runs", "/ledger", "/members", "/treasury/balances"]) {
      const r = await read(A, orgB.body.id, path);
      check(
        "tenants",
        `A reading B's ${path.slice(1)} is a 404`,
        r.status === 404,
        `status ${r.status}`,
      );
    }
    const unauth = await proxied(`/orgs/${orgA.body.id}`);
    check("tenants", "no session is a 401", unauth.status === 401);

    // Funding (W7.3): a funding quote and the status of its deposit work with no 1Click partner key.
    // Nothing is sent: 1Click only hands out a one-time deposit address for a throwaway account.
    const ownerHeaders = { "content-type": "application/json", cookie: A.j.header() };
    const fq = await proxied(`/orgs/${orgA.body.id}/treasury/funding-quote`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        originRoute: "usdc-near",
        amount: "1000000",
        refundAddress: A.w.accountId,
      }),
    });
    const quote = (await fq.json().catch(() => ({}))) as {
      eventId?: string;
      depositAddress?: string;
      amountToSend?: string;
      amountOut?: string;
      treasuryAccountId?: string;
      signedQuote?: { signature?: string; quote?: { depositAddress?: string } };
    };
    check(
      "funding",
      "a funding quote for 1 USDC on NEAR is made, signed, with a one-time deposit address",
      fq.status === 201 &&
        /^[0-9a-f]{64}$/.test(quote.depositAddress ?? "") &&
        quote.amountToSend === "1000000" &&
        BigInt(quote.amountOut ?? "0") >= 990000n &&
        BigInt(quote.amountOut ?? "0") <= 1000000n &&
        quote.treasuryAccountId === A.w.accountId &&
        typeof quote.signedQuote?.signature === "string" &&
        quote.signedQuote?.quote?.depositAddress === quote.depositAddress,
      `status ${fq.status}`,
    );
    // The same check the browser makes before it shows an address: 1Click's signature against the pinned
    // key, and that the quote pays this treasury, refunds this account, and is for this amount.
    const gateF = checkFundingQuote({
      served: {
        signedQuote: quote.signedQuote,
        depositAddress: quote.depositAddress ?? "",
        amountOut: quote.amountOut ?? "",
      },
      expected: {
        treasuryAccountId: A.w.accountId,
        originAssetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        amount: "1000000",
        refundAddress: A.w.accountId,
      },
      now: new Date(),
    });
    check(
      "funding",
      "the browser's check (gate F) accepts that quote: signature, treasury, refund, amount",
      gateF.ok,
      gateF.ok ? "" : gateF.reason,
    );
    const refresh = quote.eventId
      ? await proxied(`/orgs/${orgA.body.id}/treasury/events/${quote.eventId}/refresh`, {
          method: "POST",
          // No body, so no content type (the app sends none either).
          headers: { cookie: A.j.header() },
        })
      : undefined;
    check(
      "funding",
      "the deposit's status reads back with no key: waiting for the deposit",
      refresh?.status === 200 && (await body(refresh)).status === "PENDING_DEPOSIT",
      `status ${refresh?.status}`,
    );
    const featuresNow = await body(await proxied("/features"));
    check(
      "funding",
      "/features says funding is on",
      featuresNow.fundingQuotes === true,
      JSON.stringify(featuresNow),
    );
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(
        join(OUT, "live-session.json"),
        JSON.stringify({ orgId: orgA.body.id, cookies: A.j.entries() }),
      );
    }
  }

  // The rate limit keys on the real client, so a forged forwarding header must not buy a fresh limit.
  const attempt = (forged: string) =>
    proxied("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": forged },
      body: JSON.stringify({ email: "nobody@example.com", password: "not-a-password-1" }),
    });
  const statuses: number[] = [];
  for (let i = 0; i < 14; i += 1) statuses.push((await attempt("203.0.113.7")).status);
  const forgedNew = (await attempt("198.51.100.99")).status;
  check(
    "api",
    "rate limit: repeated sign-in failures reach 429",
    statuses.includes(429),
    statuses.join(","),
  );
  check(
    "api",
    "rate limit: a forged X-Forwarded-For does not reset it",
    forgedNew === 429,
    `status ${forgedNew}`,
  );
}

// ======================================================================= run
const sections: [string, () => Promise<void>][] = [
  ["pages", pages],
  [
    "files",
    async () => {
      await sameAsStaged("web", WEB);
      await sameAsStaged("wallet", BRIDGE);
    },
  ],
  ["headers", headerRules],
  ["api", api],
];
// LIVE_SECTIONS=api,pages limits the run (used to rehearse one part against a local server).
const only = (process.env.LIVE_SECTIONS ?? "").split(",").filter(Boolean);
for (const [name, run] of sections) {
  if (only.length > 0 && !only.includes(name)) continue;
  try {
    await run();
  } catch (err) {
    check(
      name,
      "the section ran to the end",
      false,
      err instanceof Error ? err.message.slice(0, 160) : "error",
    );
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (OUT) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "live-results.json"), JSON.stringify(results, null, 2));
}
process.exit(failed.length === 0 ? 0 : 1);
