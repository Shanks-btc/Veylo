// The Veylo wallet in a real browser (slice W6, embedded-wallet security checks). Two origins on this
// computer: a stand-in app (using the app's real bridge client) and the real wallet page built by
// build-bridge.mjs. Chrome has a virtual passkey authenticator. What it proves:
//   - the whole onboarding and a signing go over the wallet origin only: no request goes anywhere
//     else (the API included), every request is a GET, and no message or request ever carries the
//     recovery phrase or any key material;
//   - the app's origin can't read the wallet's IndexedDB or its page;
//   - a wrong wallet password fails, the right one gives the same account back, and a tampered
//     vault fails;
//   - the signature the wallet returns passes the app's own verification (the client rejects a bad
//     one, so a returned signature is a verified one);
//   - the page's headers: connect-src 'none', framed only by the app, passkeys only here.
// Run: node scripts/embedded-e2e.mjs (needs Chrome). It rebuilds out-bridge/ for local origins.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { serve } from "./serve.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
// A domain name, not an IP address: WebAuthn refuses an IP address as a relying-party id.
const APP = "http://localhost:4311";
const BRIDGE = "http://localhost:4312";
const API = "http://localhost:4399"; // never reachable: if anything asks for it, that's the finding
const PASSWORD = "a wallet password only i know";

/** "Word number 7" to 7, digit by digit (no floats anywhere). */
const wordIndex = (label) =>
  [...(/Word number (\d+)/.exec(label)?.[1] ?? "0")].reduce(
    (n, ch) => n * 10 + (ch.charCodeAt(0) - 48),
    0,
  );

/** A promise that is awaited later must not take the run down first if something else throws. */
const bg = (p) => {
  p.catch(() => {});
  return p;
};

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};

// 1. The real wallet page, built for these two local origins.
const built = spawnSync(process.execPath, [join(web, "scripts", "build-bridge.mjs")], {
  cwd: web,
  stdio: "inherit",
  env: {
    ...process.env,
    VEYLO_LOCAL_WALLET_TEST: "1",
    BRIDGE_APP_ORIGIN: APP,
    NEXT_PUBLIC_API_ORIGIN: API,
    NEXT_PUBLIC_NEAR_RPC_URL: "https://rpc.fastnear.com",
  },
});
if (built.status !== 0) process.exit(built.status ?? 1);

// 2. The stand-in app: a page and a bundle of the app's real bridge client.
const work = mkdtempSync(join(tmpdir(), "veylo-embedded-host-"));
await build({
  entryPoints: [join(web, "scripts", "embedded-host", "main.ts")],
  outfile: join(work, "host.js"),
  bundle: true,
  format: "iife",
  target: "es2022",
  logLevel: "warning",
  define: { __BRIDGE_ORIGIN__: JSON.stringify(BRIDGE) },
});
writeFileSync(
  join(work, "index.html"),
  '<!doctype html><meta charset="utf-8"><title>host</title><body><script src="/host.js"></script></body>',
);
const hostServer = createServer((req, res) => {
  const file = req.url === "/host.js" ? "host.js" : "index.html";
  res.writeHead(200, {
    "content-type": file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(readFileSync(join(work, file)));
});
await new Promise((ok) => hostServer.listen(4311, "127.0.0.1", ok));
const out = join(web, "out-bridge");
const { server: bridgeServer } = await serve(4312, { dir: out, headers: join(out, "vercel.json") });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const requests = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  ctx.on("request", (r) =>
    requests.push({
      url: r.url(),
      method: r.method(),
      post: r.postData() ?? "",
      headers: JSON.stringify(r.headers()),
    }),
  );
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  let prf = true;
  try {
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasPrf: true,
      },
    });
  } catch {
    prf = false;
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
  }
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));

  const frame = () => page.frameLocator("iframe.wallet-bridge");
  await page.goto(`${APP}/`);
  await page.waitForFunction(() => Boolean(window.host));

  // ---- Create a wallet with a password, confirm the phrase, sign ----
  const created = bg(page.evaluate(() => window.host.wallet.connect("create")));
  const startButton = frame().getByRole("button", { name: /Create my Veylo wallet/ });
  if (await startButton.isVisible({ timeout: 3000 }).catch(() => false)) await startButton.click();
  await frame().getByRole("heading", { name: "Your recovery phrase" }).waitFor({ timeout: 15000 });
  const words = (await frame().locator("ol.words li").allTextContents()).map((w) => w.trim());
  check(words.length === 12, "the recovery phrase is shown once, as 12 words");
  await frame()
    .getByRole("button", { name: /I have written them down/ })
    .click();
  await frame().getByRole("heading", { name: "Check your recovery phrase" }).waitFor();
  for (const label of await frame().locator(".field label").allTextContents()) {
    const n = wordIndex(label);
    await frame()
      .getByLabel(label, { exact: true })
      .fill(words[n - 1]);
  }
  await frame().getByRole("button", { name: "Confirm" }).click();
  // Protection: a password (the passkey path is exercised below).
  await frame().getByRole("heading", { name: "Protect your wallet" }).waitFor();
  await frame()
    .getByRole("button", { name: /Use a wallet password/ })
    .click();
  await frame().getByLabel("Wallet password").fill(PASSWORD);
  await frame().getByLabel("Type it again").fill(PASSWORD);
  await frame().getByRole("button", { name: "Protect my wallet" }).click();
  const account = await created;
  check(
    /^[0-9a-f]{64}$/.test(account.accountId),
    `the wallet's account is an implicit account (${account.accountId.slice(0, 8)}…)`,
  );

  const sign = (message) =>
    page.evaluate(
      (m) =>
        window.host.wallet
          .signMessage({ message: m, recipient: "veylo.test", nonce: new Uint8Array(32).fill(3) })
          .then(
            (s) => ({ ok: true, accountId: s.accountId, publicKey: s.publicKey }),
            (e) => ({ ok: false, error: String(e.message) }),
          ),
      message,
    );
  /** The wallet asks for approval first, then (if the vault is locked) for the wallet password. */
  const approveThenUnlock = async (f, password) => {
    const approve = f().getByRole("button", { name: "Approve" });
    await approve.waitFor({ timeout: 15000 });
    await approve.click();
    const unlock = f().getByRole("button", { name: "Unlock" });
    if (await unlock.isVisible({ timeout: 5000 }).catch(() => false)) {
      await f().getByLabel("Wallet password").fill(password);
      await unlock.click();
    }
  };
  page.on("crash", () => console.log("PAGE-CRASHED"));
  const signing = bg(sign("Pay Ada 100 USDC"));
  await approveThenUnlock(frame, PASSWORD);
  const signed = await signing;
  check(
    signed.ok && signed.accountId === account.accountId,
    `the wallet signs, and the app's own verification accepts the signature, key and account${signed.ok ? "" : ` (${signed.error})`}`,
  );

  // ---- Origin isolation ----
  const bridgeFrame = page.frames().find((f) => f.url().startsWith(BRIDGE));
  const bridgeDbs = bridgeFrame
    ? await bridgeFrame.evaluate(() => indexedDB.databases().then((d) => d.map((x) => x.name)))
    : [];
  const appDbs = await page.evaluate(() => indexedDB.databases().then((d) => d.map((x) => x.name)));
  check(bridgeDbs.includes("veylo-wallet"), "the vault is kept in the wallet origin's IndexedDB");
  check(!appDbs.includes("veylo-wallet"), "the app's origin can't see the wallet's IndexedDB");
  const peek = await page.evaluate(() => {
    const f = document.querySelector("iframe.wallet-bridge");
    try {
      return f?.contentDocument ? "readable" : "blocked";
    } catch {
      return "blocked";
    }
  });
  check(peek === "blocked", "the app's origin can't read the wallet page");

  // ---- The network: nothing but the two origins; nothing carries the phrase ----
  const hosts = new Set(requests.map((r) => new URL(r.url).host));
  check(
    [...hosts].every((h) => h === "localhost:4311" || h === "localhost:4312"),
    `every request stayed on the app and wallet origins (${[...hosts].join(", ")})`,
  );
  check(!requests.some((r) => r.url.startsWith(API)), "nothing went to the Veylo API");
  check(
    requests.every((r) => r.method === "GET" && r.post === ""),
    "every request was a GET with no body: the wallet sent nothing out",
  );
  const phrase3 = words.slice(0, 3).join(" ");
  const carries = (text) =>
    text.includes(phrase3) || words.filter((w) => text.includes(`"${w}"`)).length >= 3;
  check(
    !requests.some((r) => carries(`${r.url} ${r.post} ${r.headers}`)),
    "no request carries the recovery phrase",
  );
  const messages = await page.evaluate(() => window.host.seen);
  check(
    messages.length > 0 &&
      !messages.some((m) => carries(m) || /"(phrase|entropy|secret|privateKey|seed)"/i.test(m)),
    "no message to the app carries the phrase or any key material",
  );

  // ---- A new page load: the wallet is still here; a wrong password fails, the right one works ----
  // Connecting shows the account; the vault is unlocked when something is to be signed.
  async function reopen() {
    const p2 = await ctx.newPage();
    await p2.goto(`${APP}/`);
    await p2.waitForFunction(() => Boolean(window.host));
    const f = () => p2.frameLocator("iframe.wallet-bridge");
    const connected = bg(
      p2.evaluate(() =>
        window.host.wallet.connect().then(
          (a) => ({ ok: true, a }),
          (e) => ({ ok: false, error: String(e.message) }),
        ),
      ),
    );
    await f()
      .getByRole("button", { name: /Use my wallet on this device/ })
      .click();
    return { p2, f, connected: await connected };
  }
  async function signAfterUnlock(p2, f, password) {
    const signing = bg(
      p2.evaluate(() =>
        window.host.wallet
          .signMessage({
            message: "Pay Ada 100 USDC",
            recipient: "veylo.test",
            nonce: new Uint8Array(32).fill(3),
          })
          .then(
            (s) => ({ ok: true, accountId: s.accountId }),
            (e) => ({ ok: false, error: String(e.message) }),
          ),
      ),
    );
    const approve = f().getByRole("button", { name: "Approve" });
    await approve.waitFor({ timeout: 15000 });
    await approve.click();
    const unlock = f().getByRole("button", { name: "Unlock" });
    await unlock.waitFor({ timeout: 15000 });
    await f().getByLabel("Wallet password").fill(password);
    await unlock.click();
    return Promise.race([
      signing,
      new Promise((r) => setTimeout(() => r({ ok: false, error: "timed out" }), 20000)),
    ]);
  }

  const wrongTry = await reopen();
  check(
    wrongTry.connected.ok && wrongTry.connected.a.accountId === account.accountId,
    "the same wallet is on this device: connecting shows the same account",
  );
  const wrong = await signAfterUnlock(wrongTry.p2, wrongTry.f, "not the right password");
  check(!wrong.ok, "a wrong wallet password fails: nothing is signed");
  const rightTry = await reopen();
  const right = await signAfterUnlock(rightTry.p2, rightTry.f, PASSWORD);
  check(
    right.ok && right.accountId === account.accountId,
    "the right password unlocks it and it signs again, as the same account",
  );

  // ---- A tampered vault fails ----
  const bf = rightTry.p2.frames().find((f) => f.url().startsWith(BRIDGE));
  const tampered = await bf.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("veylo-wallet", 1);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("vault", "readwrite");
          const store = tx.objectStore("vault");
          const all = store.getAll();
          all.onsuccess = () => {
            const blob = all.result[0];
            const w = blob.wraps[0];
            const raw = atob(w.ct);
            w.ct = btoa(String.fromCharCode(raw.charCodeAt(0) ^ 1) + raw.slice(1));
            store.put(blob);
            tx.oncomplete = () => resolve(true);
          };
        };
        open.onerror = () => resolve(false);
      }),
  );
  check(tampered === true, "(set up) one byte of the stored ciphertext was changed");
  const tamperTry = await reopen();
  const afterTamper = await signAfterUnlock(tamperTry.p2, tamperTry.f, PASSWORD);
  check(!afterTamper.ok, "a tampered vault can't be unlocked, even with the right password");

  // ---- The page's headers ----
  const head = await ctx.request.get(`${BRIDGE}/embedded/`);
  const csp = head.headers()["content-security-policy"] ?? "";
  check(csp.includes("connect-src 'none'"), "the wallet page's policy says connect-src 'none'");
  check(csp.includes(`frame-ancestors ${APP}`), "only the app can frame the wallet page");
  check(
    !/unsafe-inline|unsafe-eval/.test(csp),
    "the wallet page allows no inline or dynamic script",
  );
  check(
    (head.headers()["permissions-policy"] ?? "").includes("publickey-credentials-create=(self)"),
    "passkeys are allowed on the wallet page",
  );
  const other = await ctx.request.get(`${BRIDGE}/w/meteor-wallet/`);
  check(
    !(other.headers()["permissions-policy"] ?? "").includes("publickey-credentials-create=(self)"),
    "passkeys are not allowed on any other page",
  );

  // ---- A passkey, when this Chrome can do PRF ----
  if (prf) {
    // The virtual authenticator belongs to the first page, so the passkey step runs there.
    const page5 = page;
    await page5.goto(`${APP}/`);
    await page5.waitForFunction(() => Boolean(window.host));
    const f5 = () => page5.frameLocator("iframe.wallet-bridge");
    const made = bg(
      page5.evaluate(() =>
        window.host.wallet.connect("create").then(
          (a) => ({ ok: true, a }),
          (e) => ({ ok: false, error: String(e.message) }),
        ),
      ),
    );
    const start5 = f5().getByRole("button", { name: /Create my Veylo wallet/ });
    if (await start5.isVisible({ timeout: 3000 }).catch(() => false)) await start5.click();
    await f5().getByRole("heading", { name: "Your recovery phrase" }).waitFor({ timeout: 15000 });
    const w5 = (await f5().locator("ol.words li").allTextContents()).map((w) => w.trim());
    await f5()
      .getByRole("button", { name: /I have written them down/ })
      .click();
    await f5().getByRole("heading", { name: "Check your recovery phrase" }).waitFor();
    for (const label of await f5().locator(".field label").allTextContents()) {
      const n = wordIndex(label);
      await f5()
        .getByLabel(label, { exact: true })
        .fill(w5[n - 1]);
    }
    await f5().getByRole("button", { name: "Confirm" }).click();
    await f5().getByRole("heading", { name: "Protect your wallet" }).waitFor();
    const passkeyButton = f5().getByRole("button", { name: /Use a passkey/ });
    check(await passkeyButton.isVisible(), "this Chrome offers a passkey");
    await passkeyButton.click();
    const madeResult = await Promise.race([
      made,
      new Promise((r) => setTimeout(() => r({ ok: false, error: "timed out" }), 20000)),
    ]);
    // If the virtual authenticator has no PRF, the wallet says so and asks for a password instead.
    const asksPassword = await f5()
      .getByLabel("Wallet password")
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    check(
      madeResult.ok || asksPassword,
      madeResult.ok
        ? "a passkey (PRF) protects a new wallet"
        : "this Chrome's virtual authenticator gave no PRF passkey, so the wallet fell back to a password and said so (the PRF success path is covered by the unit tests, not shown in this browser run)",
    );
  } else {
    console.log(
      "NOTE  this Chrome has no virtual PRF authenticator: the passkey path wasn't exercised here",
    );
  }
  check(
    errors.length === 0,
    `no uncaught error on the app page${errors.length ? `: ${errors[0]}` : ""}`,
  );
} catch (err) {
  const first = String(err.message).replace(/\s+/g, " ").slice(0, 300);
  console.log(`ERROR  ${first}`);
  failures.push(`the run stopped: ${first}`);
} finally {
  await browser.close();
  hostServer.close();
  bridgeServer.close();
}
console.log(
  failures.length === 0
    ? "\nOK: the Veylo wallet in a real browser"
    : `\n${failures.length} check(s) failed`,
);
process.exit(failures.length === 0 ? 0 : 1);
