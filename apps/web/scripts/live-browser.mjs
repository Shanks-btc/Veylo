// Browser checks against the LIVE deployment (slice W7), in the installed Chrome, over the real
// network. Nothing is mocked and nothing is served from this computer.
//
//   LIVE_WEB=https://... LIVE_BRIDGE=https://... [LIVE_SESSION=<live-session.json>] [LIVE_OUT=<dir>] \
//     node apps/web/scripts/live-browser.mjs [pages|picker|isolation|landing|fund|all] [--only=name,name]
//
//   pages      every page at 390 and 1440 px, light and dark: no sideways scroll, no element past the
//              edge, no console error, and axe-core: 0 serious or critical. With LIVE_SESSION (made
//              by tools/verify/src/live-check.ts) the app pages are visited signed in, as a throwaway
//              account with an empty organisation; without it they show their signed-out state.
//   picker     the wallet picker opens; each enabled wallet's page loads in a frame from the bridge
//              origin and its pinned executor is fetched from there and matches its SHA-256 pin.
//   isolation  the app origin cannot read the bridge origin's storage or document; another origin's
//              messages to the bridge page are ignored (exact origin checks, real origins).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright-core";
import { ALL_PAGES } from "./pages-list.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const WEB = (process.env.LIVE_WEB ?? "").replace(/\/$/, "");
const BRIDGE = (process.env.LIVE_BRIDGE ?? "").replace(/\/$/, "");
if (!WEB || !BRIDGE) throw new Error("LIVE_WEB and LIVE_BRIDGE are required");
const session = process.env.LIVE_SESSION
  ? JSON.parse(readFileSync(process.env.LIVE_SESSION, "utf8"))
  : undefined;
const command = process.argv[2] ?? "all";
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "")
  .slice(7)
  .split(",")
  .filter(Boolean);

const results = [];
const check = (area, name, ok, detail = "") => {
  results.push({ area, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${area.padEnd(9)} ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const host = new URL(WEB).hostname;

async function context(options, dark) {
  const ctx = await browser.newContext({ ...options, ...(dark ? { colorScheme: "dark" } : {}) });
  if (session) {
    await ctx.addCookies(
      session.cookies.map(([name, value]) => ({
        name,
        value,
        domain: host,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      })),
    );
  }
  return ctx;
}

const VIEWPORTS = [
  {
    label: "390",
    options: {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    },
  },
  { label: "1440", options: { viewport: { width: 1440, height: 900 } } },
];

/** Console noise that is the live API saying "not signed in", not a bug in the page. */
const EXPECTED_CONSOLE =
  process.env.LIVE_ALLOW_503 === "1" ? /status of (401|404|503)/ : /status of (401|404)/;
console.log("console filter:", String(EXPECTED_CONSOLE));

async function pages() {
  const list = ALL_PAGES.filter((p) => only.length === 0 || only.includes(p.name));
  const failures = [];
  const transient = [];
  let visits = 0;
  for (const vp of VIEWPORTS) {
    for (const dark of [false, true]) {
      const ctx = await context(vp.options, dark);
      if (dark)
        await ctx.addInitScript(() => localStorage.setItem("veylo.theme.signed-out", "dark"));
      const queue = [...list];
      const worker = async () => {
        const page = await ctx.newPage();
        for (;;) {
          const p = queue.shift();
          if (!p) break;
          const errors = [];
          page.on("console", (m) => {
            if (m.type() === "error" && !EXPECTED_CONSOLE.test(m.text()))
              errors.push(m.text().slice(0, 160));
          });
          page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
          try {
            const res = await page.goto(WEB + p.path, {
              waitUntil: "networkidle",
              timeout: 45_000,
            });
            await page.waitForTimeout(600);
            // Entrance animations first finish: axe reads colours, and a fading element reads wrong.
            await page
              .evaluate(() =>
                Promise.all(
                  document
                    .getAnimations()
                    .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                    .map((a) => a.finished.catch(() => {})),
                ),
              )
              .catch(() => {});
            const expected = p.status ?? 200;
            if (res?.status() !== expected)
              failures.push(`${p.name} ${vp.label}${dark ? " dark" : ""}: HTTP ${res?.status()}`);
            const overflow = await page.evaluate(() => {
              const w = document.documentElement.clientWidth;
              const wide = [...document.querySelectorAll("body *")].filter((e) => {
                const r = e.getBoundingClientRect();
                return (
                  r.width > 0 &&
                  (r.right > w + 1 || r.left < -1) &&
                  getComputedStyle(e).position !== "fixed"
                );
              });
              return {
                page: document.documentElement.scrollWidth > w + 1,
                count: wide.length,
                first: wide[0]?.className?.toString().slice(0, 40),
              };
            });
            if (overflow.page)
              failures.push(`${p.name} ${vp.label}${dark ? " dark" : ""}: sideways scroll`);
            const scan = async () =>
              (await new AxeBuilder({ page }).analyze()).violations.filter(
                (v) => v.impact === "serious" || v.impact === "critical",
              );
            let bad = await scan();
            if (bad.length > 0) {
              // A violation that is gone once the page has settled was a transient (a fade in
              // progress, a late font), not a defect: it is listed, and not counted.
              const first = bad.map((v) => v.id);
              await page.waitForTimeout(2500);
              bad = await scan();
              for (const id of first)
                if (!bad.some((v) => v.id === id))
                  transient.push(`${p.name} ${vp.label}${dark ? " dark" : ""}: axe ${id}`);
            }
            for (const v of bad)
              failures.push(
                `${p.name} ${vp.label}${dark ? " dark" : ""}: axe ${v.id} (${v.impact}) ${v.nodes
                  .slice(0, 3)
                  .map((n) => `${n.target.join(" ")} ${JSON.stringify(n.any[0]?.data ?? {})}`)
                  .join(" ; ")}`,
              );
            // These two pages are opened with a made-up token, and the API's answer to that is a 400.
            const real = errors.filter(
              (e) =>
                !(/status of 400/.test(e) && ["verify-email", "reset-password"].includes(p.name)),
            );
            if (real.length)
              failures.push(`${p.name} ${vp.label}${dark ? " dark" : ""}: console ${real[0]}`);
            visits += 1;
          } catch (err) {
            failures.push(
              `${p.name} ${vp.label}${dark ? " dark" : ""}: ${String(err.message).split("\n")[0].slice(0, 100)}`,
            );
          }
          page.removeAllListeners("console");
          page.removeAllListeners("pageerror");
        }
        await page.close();
      };
      await Promise.all(Array.from({ length: 3 }, worker));
      await ctx.close();
    }
  }
  if (process.env.LIVE_OUT) {
    mkdirSync(process.env.LIVE_OUT, { recursive: true });
    writeFileSync(
      join(process.env.LIVE_OUT, "live-browser-pages-failures.json"),
      JSON.stringify(failures, null, 2),
    );
  }
  if (transient.length > 0)
    console.log(
      `INFO    pages     transient axe results that cleared on a second scan: ${transient.join("; ")}`,
    );
  check(
    "pages",
    `${list.length} pages x 390 and 1440 px x light and dark (${visits} visits)${session ? ", signed in" : ", signed out"}: no sideways scroll, 0 serious or critical axe, no console error`,
    failures.length === 0,
    failures.slice(0, 6).join("; "),
  );
}

async function picker() {
  const lock = JSON.parse(readFileSync(join(web, "src", "wallet", "wallets.lock.json"), "utf8"));
  const enabled = lock.wallets.filter((w) => w.enabled);
  const ctx = await context(VIEWPORTS[1].options, false);
  const page = await ctx.newPage();
  const problems = [];
  const cosmetic = new Set();
  page.on("console", (m) => {
    // A refused connection breaks a wallet. Refused fonts and styles inside a wallet's own sandboxed
    // window only change how that window looks (the policy is deliberately closed), so they are only counted.
    const text = m.text();
    if (m.type() !== "error") return;
    if (/Connecting to /.test(text)) problems.push(text.slice(0, 140));
    else if (/Content Security Policy/.test(text))
      cosmetic.add(text.replace(/'[^']*'/, "'…'").slice(0, 60));
  });
  await page.goto(`${WEB}/app/sign-in`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /use a wallet instead/i }).click();
  await page.locator(".picker-item").first().waitFor({ timeout: 15_000 });
  const items = await page.locator(".picker-item").count();
  check(
    "picker",
    "the wallet picker opens on production and lists the Veylo wallet and every enabled wallet",
    items === enabled.length + 2,
    `${items} entries, ${enabled.length} enabled wallets`,
  );

  const bad = [];
  for (const w of enabled) {
    // Watch for the executor the bridge page fetches from its own origin.
    const executorUrl = `${BRIDGE}/wallets/${w.executor.file}`;
    let fetched = false;
    const onResponse = (r) => {
      if (r.url().split("?")[0] === executorUrl && r.status() === 200) fetched = true;
    };
    ctx.on("response", onResponse);
    const entry = page.locator(".picker-item", { hasText: w.name }).first();
    if ((await entry.count()) === 0) {
      bad.push(`${w.id}: not in the picker`);
      ctx.off("response", onResponse);
      continue;
    }
    await entry.click();
    const frame = page.locator(`iframe.wallet-bridge[src^="${BRIDGE}/w/${w.id}/"]`);
    try {
      await frame.waitFor({ state: "attached", timeout: 15_000 });
      for (let i = 0; i < 40 && !fetched; i += 1) await page.waitForTimeout(250);
    } catch {
      bad.push(`${w.id}: no frame from the bridge origin`);
    }
    // The pin is the file's content hash (and its name carries it): the page loaded it, and the bytes
    // the bridge origin serves hash to the pin.
    const bytes = await (await ctx.request.get(executorUrl)).body();
    const served = createHash("sha256").update(bytes).digest("hex");
    if (!fetched) bad.push(`${w.id}: the page never fetched its executor`);
    if (served !== w.executor.sha256) bad.push(`${w.id}: executor hash differs from its pin`);
    ctx.off("response", onResponse);
    // Back to a clean picker for the next one.
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: /use a wallet instead/i }).click();
    await page.locator(".picker-item").first().waitFor({ timeout: 15_000 });
  }
  check(
    "picker",
    `each of ${enabled.length} wallets loads from the bridge origin and its pinned executor's SHA-256 matches`,
    bad.length === 0,
    bad.join("; "),
  );

  // The Veylo wallet page opens in a frame from the bridge origin too.
  await page
    .locator(".picker-item", { hasText: /Create my Veylo wallet/i })
    .first()
    .click();
  const emb = page.locator(`iframe.wallet-bridge[src^="${BRIDGE}/embedded/"]`);
  let embOk = true;
  try {
    await emb.waitFor({ state: "attached", timeout: 15_000 });
  } catch {
    embOk = false;
  }
  check("picker", "the Veylo wallet page opens in a frame from the bridge origin", embOk);
  check(
    "picker",
    "no wallet connection is refused by the bridge page's policy",
    problems.length === 0,
    problems[0] ?? "",
  );
  if (cosmetic.size > 0)
    console.log(
      `INFO    picker    ${cosmetic.size} kind(s) of refused font or stylesheet inside wallet windows (cosmetic)`,
    );
  await ctx.close();
}

async function isolation() {
  const ctx = await context(VIEWPORTS[1].options, false);
  const app = await ctx.newPage();
  await app.goto(`${WEB}/app/sign-in`, { waitUntil: "networkidle" });
  // A marker in the app origin's storage; another in the bridge origin's.
  await app.evaluate(() => {
    localStorage.setItem("w7-app-marker", "app");
    return new Promise((done) => {
      const req = indexedDB.open("w7-app-db", 1);
      req.onsuccess = () => done(undefined);
    });
  });
  const bridge = await ctx.newPage();
  await bridge.goto(`${BRIDGE}/embedded/`, { waitUntil: "load" });
  await bridge.evaluate(() => {
    localStorage.setItem("w7-bridge-marker", "bridge");
    return new Promise((done) => {
      const req = indexedDB.open("w7-bridge-db", 1);
      req.onsuccess = () => done(undefined);
    });
  });
  const seenByBridge = await bridge.evaluate(async () => ({
    ls: localStorage.getItem("w7-app-marker"),
    dbs: (await indexedDB.databases()).map((d) => d.name),
  }));
  const seenByApp = await app.evaluate(async () => ({
    ls: localStorage.getItem("w7-bridge-marker"),
    dbs: (await indexedDB.databases()).map((d) => d.name),
  }));
  check(
    "isolation",
    "the bridge origin cannot see the app origin's localStorage or IndexedDB",
    seenByBridge.ls === null && !seenByBridge.dbs.includes("w7-app-db"),
  );
  check(
    "isolation",
    "the app origin cannot see the bridge origin's localStorage or IndexedDB",
    seenByApp.ls === null && !seenByApp.dbs.includes("w7-bridge-db"),
  );

  // The app cannot reach into a bridge frame's document or storage.
  const peek = await app.evaluate(async (bridgeOrigin) => {
    const f = document.createElement("iframe");
    f.src = `${bridgeOrigin}/embedded/`;
    document.body.append(f);
    await new Promise((r) => f.addEventListener("load", r, { once: true }));
    try {
      void f.contentWindow.document.body;
      return "readable";
    } catch {
      try {
        void f.contentWindow.localStorage;
        return "readable";
      } catch {
        return "blocked";
      }
    }
  }, BRIDGE);
  check(
    "isolation",
    "the app page cannot read a bridge frame's document or storage",
    peek === "blocked",
    peek,
  );

  // Messages: a page on any other origin that reaches the bridge page gets no answer. Another origin
  // is made by serving a page at https://attacker.example from this browser; it opens the bridge page
  // in a window and sends the real protocol's first message. The bridge page answers only its parent
  // frame at exactly the app origin, so nothing comes back (and the page would not be framed at all).
  const other = await ctx.newPage();
  await other.route("https://attacker.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>other</title><body>other origin</body>",
    }),
  );
  await other.goto("https://attacker.example/");
  const answered = await other.evaluate(async (bridgeOrigin) => {
    const replies = [];
    window.addEventListener("message", (e) => replies.push(e.origin));
    const w = window.open(`${bridgeOrigin}/embedded/`, "bridge");
    await new Promise((r) => setTimeout(r, 2500));
    // "disconnect" is answered at once by the page that is allowed to ask, so silence means refusal.
    const msg = {
      protocol: "veylo-wallet-bridge/1",
      kind: "disconnect",
      requestId: "w7-live-check-0001",
    };
    try {
      w.postMessage(msg, bridgeOrigin);
    } catch {
      // Blocked outright.
    }
    await new Promise((r) => setTimeout(r, 2500));
    return replies.length;
  }, BRIDGE);
  check(
    "isolation",
    "a page on another origin gets no reply from the bridge page",
    answered === 0,
    `${answered} replies`,
  );

  // The refusal is by origin, not by accident: the same message framed by the real app does get a reply.
  const reply = await app.evaluate(async (bridgeOrigin) => {
    const f = document.createElement("iframe");
    f.src = `${bridgeOrigin}/embedded/`;
    document.body.append(f);
    await new Promise((r) => f.addEventListener("load", r, { once: true }));
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("none"), 6000);
      window.addEventListener("message", (e) => {
        if (e.origin === bridgeOrigin) {
          clearTimeout(timer);
          resolve("replied");
        }
      });
      f.contentWindow.postMessage(
        { protocol: "veylo-wallet-bridge/1", kind: "disconnect", requestId: "w7-live-check-0002" },
        bridgeOrigin,
      );
    });
  }, BRIDGE);
  check(
    "isolation",
    "the bridge answers the app origin (so the refusal above is by origin)",
    reply === "replied",
    reply,
  );
  await ctx.close();
}

/** The landing page on the live URL, as a visitor sees it, at a phone and a desktop size. */
async function landing() {
  const shots = process.env.LIVE_OUT ? join(process.env.LIVE_OUT, "shots") : undefined;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const [label, options] of [
    [
      "375",
      {
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    ],
    ["768", { viewport: { width: 768, height: 1024 } }],
    ["1440", { viewport: { width: 1440, height: 900 } }],
  ]) {
    const ctx = await browser.newContext(options);
    const page = await ctx.newPage();
    // Only what the landing page itself does counts: the sign-up page asks the API who is signed in,
    // and for a visitor that honest answer is a 401 the browser logs.
    let onLanding = true;
    const errors = [];
    page.on("console", (m) => {
      if (onLanding && m.type() === "error") errors.push(m.text().slice(0, 160));
    });
    page.on("pageerror", (e) => onLanding && errors.push(String(e.message).slice(0, 160)));
    page.on("response", (r) => {
      if (onLanding && r.status() >= 400)
        errors.push(`HTTP ${r.status()} ${r.url().slice(0, 100)}`);
    });
    page.on("requestfailed", (r) => onLanding && errors.push(`failed ${r.url().slice(0, 100)}`));
    await page.goto(`${WEB}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(4500);
    const at = (name) => `${label}px`;
    // Hero: one action, the sample workspace, the trust line, the sign-up link, no marquee, no chips.
    const hero = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const visible = (el) =>
        !!el &&
        el.getBoundingClientRect().height > 0 &&
        getComputedStyle(el).visibility !== "hidden";
      return {
        lede: q("#top .hero-lede")?.textContent?.trim(),
        buttons: document.querySelectorAll("#top .btn").length,
        chips: document.querySelectorAll("#top .chips, #top .chip, #top .pchip, #top .proof-row")
          .length,
        link: [
          q("#top .hero-link")?.textContent?.trim(),
          q("#top .hero-link")?.getAttribute("href"),
        ],
        sample: q("#top .hp-caption")?.textContent?.trim(),
        cards: [...document.querySelectorAll("#top .hp-card")].filter(visible).length,
        amount: q("#top .hp-amount .hp-final")?.textContent?.trim(),
        tiles: [...document.querySelectorAll("#top .hp-tile")].map((t) => t.textContent.trim()),
        bars: document.querySelectorAll("#top .hp-bars, #top .hp-chart, #top .hp-spark").length,
        contractorLabel: q("#top .hp-contractor .hp-eye")?.textContent?.trim(),
        payslipHeight: Math.round(q("#top .private-card")?.getBoundingClientRect().height ?? 0),
        columnsEnd: (() => {
          const t = q("#top .hp-treasury")?.getBoundingClientRect();
          const c = q("#top .hp-contractor")?.getBoundingClientRect();
          return t && c ? Math.round(Math.abs(t.bottom - c.bottom)) : -1;
        })(),
        trust: q("#top .trust-line")?.textContent?.trim().replace(/\s+/g, " "),
        trustLinks: [...document.querySelectorAll("#top .trust-line a")].map((a) => [
          a.textContent.trim(),
          a.getAttribute("href"),
        ]),
        payslip: q("#top .private-card")?.textContent?.replace(/\s+/g, " ").trim(),
        open: [...document.querySelectorAll("#top .cta a")].map((a) => [
          a.textContent.trim(),
          a.getAttribute("href"),
        ]),
        condLine:
          document.body.innerText.includes(
            "Private means no public source we checked links a confidential payout to the company, provided the payout address has never received a public payment from it.",
          ) && !!q("#top")?.innerText.includes("Private means no public source"),
        marquee:
          !!q(".mq, .mq-track") ||
          /Payslips and CSV|Borderless payroll on NEAR/.test(document.body.innerText),
        navLinks: [...document.querySelectorAll(".nav-links a")].map((a) => a.textContent.trim()),
        navCta: q(".nav .nav-open")?.textContent?.trim(),
        navCtaHref: q(".nav .nav-open")?.getAttribute("href"),
        problem: visible(q("#problem")) && /the problem/i.test(q("#problem")?.innerText ?? ""),
        problemH: q("#problem h2")?.textContent?.trim(),
        solution: visible(q("#solution")) && /the solution/i.test(q("#solution")?.innerText ?? ""),
        solutionH: q("#solution h2")?.textContent?.trim(),
        fixes: q(".fixes, .pitch-lead, .pitch-dark") ? "leftover" : "none",
        order: ["top", "problem", "solution", "how", "product", "story", "who", "faq", "start"].map(
          (id) => document.getElementById(id)?.getBoundingClientRect().top + window.scrollY,
        ),
        steps: [...document.querySelectorAll("#how .how-step h3")].map((h) => h.textContent.trim()),
        diagrams: [...document.querySelectorAll("#how .tree svg")].filter(
          (s) => getComputedStyle(s).display !== "none",
        ).length,
        typedTick: /[✓✔]/.test(document.body.innerText),
        faqStill: !!q("#faq"),
        footerFaq: !!document.querySelector('.footer a[href="#faq"]'),
      };
    });
    check(
      "landing",
      `${at()}: #problem and #solution render`,
      hero.problem &&
        hero.solution &&
        hero.problemH?.startsWith("Paying your team onchain") &&
        hero.solutionH?.startsWith("One private treasury"),
      `${hero.problemH} | ${hero.solutionH}`,
    );
    check(
      "landing",
      `${at()}: the hero has the two-line subline, one button, a text link and no chips`,
      hero.lede ===
        "Companies pay global teams privately in USDC on NEAR. Gasless for your team." &&
        hero.buttons === 1 &&
        hero.chips === 0 &&
        hero.link[0] === "See how it works" &&
        hero.link[1] === "#how",
      JSON.stringify([hero.lede, hero.buttons, hero.chips, hero.link]),
    );
    check(
      "landing",
      `${at()}: the sample workspace is one panel of three cards (balance, three tiles, no bar chart), with a compact payslip card in its "Contractor card" section`,
      hero.sample === "Sample workspace" &&
        hero.cards === 3 &&
        hero.amount === "$248,420.50" &&
        hero.tiles.length === 3 &&
        hero.bars === 0 &&
        hero.contractorLabel === "Contractor card" &&
        hero.payslipHeight > 0 &&
        hero.payslipHeight <= (label === "375" ? 235 : 185) &&
        (label !== "1440" || hero.columnsEnd <= 2) &&
        /Ada L\./.test(hero.payslip ?? "") &&
        /PRIVATE|Private/.test(hero.payslip ?? ""),
      JSON.stringify([
        hero.sample,
        hero.cards,
        hero.amount,
        hero.tiles.length,
        hero.bars,
        hero.payslipHeight,
        hero.columnsEnd,
      ]),
    );
    check(
      "landing",
      `${at()}: the trust line is plain text with one link, to /proof`,
      /^Live on NEAR mainnet · \d+ test transactions verified · \d+ wallets · Gasless for payees$/.test(
        hero.trust ?? "",
      ) &&
        hero.trustLinks.length === 1 &&
        hero.trustLinks[0][1] === "/proof" &&
        /^\d+ test transactions verified$/.test(hero.trustLinks[0][0]),
      JSON.stringify([hero.trust, hero.trustLinks]),
    );
    check(
      "landing",
      `${at()}: the sections run hero, problem, solution, how it works, features, tour, who, FAQ, closing`,
      hero.order.every((t, i) => t >= 0 && (i === 0 || t > hero.order[i - 1])),
      hero.order.join(", "),
    );
    check(
      "landing",
      `${at()}: how it works has the four steps and one drawing; the problem and solution are plain sections (no band, no connector)`,
      hero.steps.join("|") === "Add your team|Fund in USDC|Review and approve|Paid, privately" &&
        hero.diagrams === 1 &&
        hero.fixes === "none",
      JSON.stringify([hero.steps, hero.diagrams, hero.fixes]),
    );
    check("landing", `${at()}: no typed check mark on the page`, hero.typedTick === false);
    check("landing", `${at()}: the marquee is gone`, hero.marquee === false);
    check(
      "landing",
      `${at()}: the hero no longer carries the privacy line`,
      hero.condLine === false,
    );
    check(
      "landing",
      `${at()}: 'Open a treasury' goes to /app/sign-up`,
      hero.open[0]?.[0] === "Open a treasury" && hero.open[0]?.[1] === "/app/sign-up",
      JSON.stringify(hero.open),
    );
    if (label === "1440") {
      check(
        "landing",
        `${at()}: the navigation is How it works, Features, Tour, Docs and Sign in (no FAQ)`,
        hero.navLinks.join("|") === "How it works|Features|Tour|Docs" &&
          hero.navCta === "Sign in" &&
          hero.navCtaHref === "/app/sign-in",
        `${hero.navLinks.join(", ")} + ${hero.navCta}`,
      );
    }
    check(
      "landing",
      `${at()}: the FAQ section and its footer link stay`,
      hero.faqStill && hero.footerFaq,
    );

    // Hero screenshot, then the story.
    if (shots) await page.locator("#top").screenshot({ path: join(shots, `hero-${label}.png`) });
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < total; y += 400) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(1200);
    const story = await page.evaluate(() => {
      const rect = (e) => e.getBoundingClientRect();
      const hit = (a, b) =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      const steps = [...document.querySelectorAll("#story .tl-step")];
      const overlaps = [];
      for (const s of steps) {
        const t = s.querySelector(".tl-text");
        const v = s.querySelector(".tl-visual");
        if (hit(rect(t), rect(v))) overlaps.push("text/picture");
        for (const p of s.querySelectorAll("p, h3"))
          if (p.scrollHeight > p.clientHeight + 1) overlaps.push("cut-off text");
        for (const el of s.querySelectorAll("*")) {
          const tr = getComputedStyle(el).transform;
          const m = /matrix\(([\d.]+), 0, 0, ([\d.]+)/.exec(tr);
          if (m && Math.abs(+m[1] - 1) > 0.01) overlaps.push("scaled");
        }
      }
      for (let i = 1; i < steps.length; i += 1)
        if (hit(rect(steps[i - 1]), rect(steps[i]))) overlaps.push("step/step");
      const sticky = [...document.querySelectorAll("#story *")].some(
        (e) => getComputedStyle(e).position === "sticky",
      );
      return {
        steps: steps.length,
        overlaps,
        sticky,
        sideways: document.documentElement.scrollWidth - innerWidth,
      };
    });
    check(
      "landing",
      `${at()}: the story is a timeline of four rows with no overlap, no clipping, no pinning`,
      story.steps === 4 && story.overlaps.length === 0 && !story.sticky && story.sideways <= 0,
      JSON.stringify(story),
    );
    if (shots) {
      await page.locator("#story").screenshot({ path: join(shots, `story-${label}.png`) });
      // The sample workspace panel, the problem, the solution, how it works, the quote.
      await page.locator("#top .hp").screenshot({ path: join(shots, `hero-panel-${label}.png`) });
      await page.locator("#problem").screenshot({ path: join(shots, `problem-${label}.png`) });
      await page.locator("#solution").screenshot({ path: join(shots, `solution-${label}.png`) });
      await page.locator("#how").screenshot({ path: join(shots, `how-${label}.png`) });
      await page.locator(".band").screenshot({ path: join(shots, `quote-${label}.png`) });
    }

    // Signed-out visitor to the sign-up page through the hero button.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1500);
    onLanding = false;
    await Promise.all([
      page.waitForURL(/\/app\/sign-up/),
      page.locator("#top .cta a", { hasText: "Open a treasury" }).click(),
    ]);
    check(
      "landing",
      `${at()}: clicking 'Open a treasury' lands on /app/sign-up`,
      new URL(page.url()).pathname === "/app/sign-up",
    );

    if (label === "375") {
      onLanding = true;
      await page.goto(`${WEB}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(3800);
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.waitForTimeout(1100);
      const drawer = await page.evaluate(() => {
        const p = document.querySelector(".drawer-panel");
        const cs = getComputedStyle(p);
        const [r, g, b] = (/rgba?\((\d+), (\d+), (\d+)/.exec(cs.backgroundColor) ?? [0, 0, 0, 0])
          .slice(1)
          .map((v) => +v);
        const grad = cs.backgroundImage;
        return {
          open: document.querySelector("dialog.drawer").open,
          links: [...document.querySelectorAll(".drawer nav a")].map((a) => a.textContent.trim()),
          cta: document.querySelector(".drawer-foot .btn")?.textContent.trim(),
          ctaHref: document.querySelector(".drawer-foot .btn")?.getAttribute("href"),
          dark: /rgba\((?:1[0-9]|2[0-9]|3[0-9]|[0-9]), /.test(grad) || (r + g + b) / 3 < 80,
          blur: cs.backdropFilter,
          minLink: Math.min(
            ...[...document.querySelectorAll(".drawer nav a")].map(
              (a) => a.getBoundingClientRect().height,
            ),
          ),
          locked: getComputedStyle(document.documentElement).overflow === "hidden",
        };
      });
      check(
        "landing",
        "375px: the drawer is the dark glass panel with How it works, Features, Tour, Docs and Sign in, locking the page",
        drawer.open &&
          drawer.links.join("|") === "How it works|Features|Tour|Docs" &&
          drawer.cta === "Sign in" &&
          drawer.ctaHref === "/app/sign-in" &&
          drawer.dark &&
          /blur/.test(drawer.blur) &&
          drawer.minLink >= 44 &&
          drawer.locked,
        JSON.stringify(drawer),
      );
      if (shots) await page.screenshot({ path: join(shots, "drawer-375.png") });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
    }
    // Wait for any late request, then count what the console said.
    await page.waitForTimeout(1500);
    check(
      "landing",
      `${at()}: zero console errors, failed requests or HTTP errors`,
      errors.length === 0,
      errors.slice(0, 3).join(" | "),
    );
    await ctx.close();
  }
}

/**
 * The Fund screen on the live site (W7.3), signed in as the throwaway account of live-check.ts: the
 * panel is there before any click, "Selected" scrolls to it, the private balance speaks in words, and a
 * REAL 1Click funding quote (made with no partner key, nothing sent) passes the browser's own signature
 * check and shows its deposit address, QR code and copy button. Needs LIVE_SESSION.
 */
async function fund() {
  if (!session) return check("fund", "needs LIVE_SESSION (made by live-check.ts)", false);
  const RAW_CODE = /\b[a-z]{2,}(?:_[a-z]{2,})+\b|\b[A-Z]{2,}(?:_[A-Z]{2,})+\b/;
  for (const view of VIEWPORTS) {
    const at = `${view.label}px`;
    const ctx = await context(view.options, false);
    await ctx
      .grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB })
      .catch(() => {});
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 140)));
    await page.goto(`${WEB}/app/fund`, { waitUntil: "networkidle" });
    await page
      .locator("#fund-panel")
      .waitFor({ timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(800);
    const panel = page.locator("#fund-panel");
    const treasury = (
      await panel
        .locator(".copy-value")
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    check(
      "fund",
      `${at}: the panel is under the selected option before any click, with the treasury account in full`,
      (await panel.isVisible()) && /^[0-9a-f]{64}$/.test(treasury),
      treasury.slice(0, 12),
    );
    check(
      "fund",
      `${at}: QR code, copy button and four steps are in the panel`,
      (await panel.locator("svg.qr").count()) >= 1 &&
        (await panel.getByRole("button", { name: /Copy Treasury account/ }).count()) === 1 &&
        (await panel.locator(".fund-steps li").count()) >= 4,
    );
    const main = await page.locator("main").innerText();
    check(
      "fund",
      `${at}: the private balance says what to do, in words`,
      main.includes("Connect your wallet to see your private balance") &&
        main.includes("Not shown yet") &&
        !RAW_CODE.test(main.replace(treasury, "")),
      RAW_CODE.exec(main.replace(treasury, ""))?.[0] ?? "",
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole("button", { name: "Selected" }).click();
    await page.waitForTimeout(1100);
    const top = await page.evaluate(
      () => document.querySelector("#fund-panel")?.getBoundingClientRect().top ?? -1,
    );
    const bottomed = await page.evaluate(
      () => window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2,
    );
    check(
      "fund",
      `${at}: clicking "Selected" brings the panel to the top of the screen`,
      top <= 170 || bottomed,
      `${Math.round(top)}px`,
    );

    // A real funding quote with no key, through the live API, checked by the browser before it is shown.
    await page.locator("#fund-amount").fill("1");
    await page.getByRole("button", { name: "Get my deposit address" }).click();
    const shown = await page
      .getByText("Send exactly this")
      .waitFor({ timeout: 25000 })
      .then(
        () => true,
        () => false,
      );
    const text = await page.locator("#fund-panel").innerText();
    const address = (
      await page
        .locator(".fund-quote .copy-value")
        .first()
        .innerText()
        .catch(() => "")
    ).trim();
    check(
      "fund",
      `${at}: a live funding quote passes the browser's check and shows its deposit address, QR, copy button and steps`,
      shown &&
        /^[0-9a-f]{64}$/.test(address) &&
        address !== treasury &&
        (await page.locator(".fund-quote svg.qr").count()) === 1 &&
        (await page.locator(".fund-quote .fund-steps li").count()) === 4,
      shown ? address.slice(0, 12) : text.slice(-160).replace(/\s+/g, " "),
    );
    await page
      .getByRole("button", { name: /I've sent it/ })
      .click()
      .catch(() => {});
    const waiting = await page
      .getByText("Waiting for your deposit")
      .waitFor({ timeout: 15000 })
      .then(
        () => true,
        () => false,
      );
    check(
      "fund",
      `${at}: the deposit's status is in words ("Waiting for your deposit")`,
      waiting && !/PENDING_DEPOSIT/.test(await page.locator("main").innerText()),
    );
    check(
      "fund",
      `${at}: no sideways scroll, no script error`,
      (await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)) &&
        errors.length === 0,
      errors[0] ?? "",
    );
    if (process.env.LIVE_OUT) {
      mkdirSync(join(process.env.LIVE_OUT, "shots"), { recursive: true });
      await page.screenshot({
        path: join(process.env.LIVE_OUT, "shots", `fund-${view.label}.png`),
        fullPage: true,
      });
    }
    await ctx.close();
  }
}

try {
  if (command === "pages" || command === "all") await pages();
  if (command === "picker" || command === "all") await picker();
  if (command === "isolation" || command === "all") await isolation();
  if (command === "landing" || command === "all") await landing();
  if (command === "fund" || command === "all") await fund();
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (process.env.LIVE_OUT) {
  mkdirSync(process.env.LIVE_OUT, { recursive: true });
  writeFileSync(
    join(process.env.LIVE_OUT, `live-browser-${command}.json`),
    JSON.stringify(results, null, 2),
  );
}
process.exit(failed.length === 0 ? 0 : 1);
