// Browser checks on the demo build (out-demo, from `pnpm --filter @veylo/web build:demo`), in the
// installed Chrome, with no mocked network:
//   axe-core on the landing page and every app screen, light and dark (0 serious or critical);
//   keyboard-only walkthroughs of sign-in and of pay run review through approval;
//   "Try to redirect a payout": the checks refuse it and Approve stays disabled (slice W5, C3);
//   the proof and verify pages fail closed when NEAR can't be read (the network is blocked);
//   reduced motion; no horizontal scroll at 360, 390, 768, 1024 and 1440 px, with screenshots;
//   three.js loads only after first paint; no CSP violation on any page.
// Every host but this computer is refused (set E2E_LIVE=1 to let the read-only archival NEAR RPC
// through, to see the live proofs).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { serve } from "./serve.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const shots = join(web, "..", "..", "design", "screenshots");
mkdirSync(shots, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const LIVE = process.env.E2E_LIVE === "1";

// The demo world's ids (src/demo/world.ts).
const ORG = "11111111-1111-4111-8111-111111111111";
const OPEN_RUN = "22222222-2222-4222-8222-222222222222";
const DONE_RUN = "22222222-2222-4222-8222-333333333333";
const KWAME = "33333333-3333-4333-8333-333333333333";
const ITEM_DIRECT = "66666666-6666-4666-8666-666666666663";
const ITEM_PRIVATE = "66666666-6666-4666-8666-666666666664";
const ACCOUNT = "a87a0e4f93085edbe787aa4530021045f426c8fbc500a7c1dbd729dc4f8151ce";

async function context(browser, options = {}, signedIn = true) {
  const ctx = await browser.newContext(options);
  await ctx.addInitScript(
    ({ signedIn, account }) => {
      try {
        if (signedIn) sessionStorage.setItem("veylo.demo.signedIn", "1");
        if (localStorage.getItem("veylo.theme.test") === null)
          localStorage.setItem("veylo.theme.test", "x");
        void account;
      } catch {
        // No storage in this context.
      }
    },
    { signedIn, account: ACCOUNT },
  );
  await ctx.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    if (LIVE && url.hostname === "archival-rpc.mainnet.fastnear.com") return route.continue();
    return route.abort("blockedbyclient"); // No live network.
  });
  return ctx;
}

const results = {
  axe: [],
  keyboard: [],
  tamper: {},
  failClosed: {},
  motion: {},
  responsive: [],
  three: {},
  cspViolations: [],
};
const PAGES = [
  ["landing", "/"],
  ["sign-in", "/app/sign-in"],
  ["setup", "/app/setup"],
  ["treasury", "/app"],
  ["contractors", "/app/contractors"],
  ["contractor", `/app/contractor?id=${KWAME}`],
  ["pay-runs", "/app/pay-runs"],
  ["pay-run-review", `/app/pay-run?id=${OPEN_RUN}`],
  ["pay-run-status", `/app/pay-run/status?id=${DONE_RUN}`],
  ["ledger", "/app/ledger"],
  ["add-address", `/app/contractor/add-address?id=${KWAME}`],
  ["privacy-proof", "/app/privacy-proof"],
  ["proof", "/proof"],
  ["verify-direct", `/verify?payout=${ITEM_DIRECT}`],
  ["verify-private", `/verify?payout=${ITEM_PRIVATE}`],
];

async function open(page, origin, path) {
  page.removeAllListeners("console");
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text()))
      results.cspViolations.push(`${path}: ${m.text().slice(0, 160)}`);
  });
  await page.goto(origin + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
}

const { server, origin } = await serve(0, { dir: join(web, "out-demo") });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  // axe on every page, light, then the app screens in the dark theme.
  {
    const ctx = await context(browser, { viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const scan = async (name, path, extra = {}) => {
      await open(page, origin, path);
      const r = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      results.axe.push({
        page: name,
        serious: bad.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target}`),
        ...extra,
      });
    };
    for (const [name, path] of PAGES) {
      await scan(name, path, {
        errorNotes: await (async () => await page.locator(".error-note").allTextContents())(),
      });
    }
    await page.evaluate(
      (account) => localStorage.setItem(`veylo.theme.${account}`, "dark"),
      ACCOUNT,
    );
    for (const [name, path] of PAGES.filter(
      ([n]) => !["landing", "sign-in", "proof", "verify-direct", "verify-private"].includes(n),
    ))
      await scan(`${name} (dark)`, path);
    await ctx.close();
  }

  // Keyboard-only: sign-in with the demo wallet.
  {
    const ctx = await context(browser, { viewport: { width: 1280, height: 900 } }, false);
    const page = await ctx.newPage();
    const focused = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        return {
          text: (el?.textContent ?? "").trim().slice(0, 60),
          outline: el ? getComputedStyle(el).outlineStyle : "none",
        };
      });
    await open(page, origin, "/app/sign-in");
    let reached;
    for (let i = 0; i < 12 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      const f = await focused();
      if (/Use a wallet instead/.test(f.text)) reached = f;
    }
    const walk = {
      flow: "sign-in",
      reachedConnect: !!reached,
      focusVisible: reached?.outline !== "none",
    };
    if (reached) {
      // Enter opens the wallet dialog; the demo has one stand-in wallet, reached by Tab.
      await page.keyboard.press("Enter");
      let demo;
      for (let i = 0; i < 8 && !demo; i += 1) {
        await page.keyboard.press("Tab");
        const f = await focused();
        if (/Use the demo wallet/.test(f.text)) demo = f;
      }
      walk.reachedDemoWallet = !!demo;
      if (demo) await page.keyboard.press("Enter");
      await page.waitForURL(/\/app\/setup$|\/app\/?$/, { timeout: 20000 }).catch(() => undefined);
      walk.signedInAndRedirected = /\/app(\/setup)?\/?$/.test(new URL(page.url()).pathname);
    }
    results.keyboard.push(walk);
    await ctx.close();
  }

  // Keyboard-only: pay run review through approval; and the tamper refusal in the real UI.
  {
    const ctx = await context(browser, { viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const approve = () => page.getByRole("button", { name: /Approve payouts in wallet/ });
    const passes = () => page.locator(".checklist .check-pass").count();
    const fails = () => page.locator(".checklist .check-fail").count();

    await open(page, origin, `/app/pay-run?id=${OPEN_RUN}`);
    const walk = {
      flow: "pay run review through approval",
      approveDisabledBeforeChecks: await approve().isDisabled(),
    };
    const check = page.getByRole("button", { name: /Check before signing/ });
    await check.focus();
    await page.keyboard.press("Enter");
    await page
      .waitForFunction(
        () => document.querySelectorAll(".checklist .check-pass").length === 5,
        undefined,
        { timeout: 30000 },
      )
      .catch(() => undefined);
    walk.fivePassed = (await passes()) === 5;
    walk.approveEnabledAfterPass = await approve().isEnabled();

    // C3: redirect a payout. The checks refuse it and Approve stays disabled.
    const attack = page.getByRole("button", { name: /Redirect Kwame's payout to an attacker/ });
    await attack.click();
    await page
      .waitForFunction(
        () => document.querySelectorAll(".checklist .check-fail").length >= 2,
        undefined,
        { timeout: 30000 },
      )
      .catch(() => undefined);
    const failedRows = await page.locator(".checklist .check-fail").allTextContents();
    results.tamper = {
      failedChecks: failedRows.length,
      aFailed: failedRows.some((t) => /Quote signed by NEAR Intents/.test(t)),
      bFailed: failedRows.some((t) => /Payee on the signed list/.test(t)),
      plainWords: failedRows.some((t) => /swapped|changed after NEAR Intents signed/.test(t)),
      approveDisabled: await approve().isDisabled(),
    };
    await page.screenshot({ path: join(shots, "tamper-refused.png"), fullPage: true });
    await page.getByRole("button", { name: /Undo the attack/ }).click();
    await page
      .waitForFunction(
        () => document.querySelectorAll(".checklist .check-pass").length === 5,
        undefined,
        { timeout: 30000 },
      )
      .catch(() => undefined);
    results.tamper.passesAgainAfterUndo = (await passes()) === 5;

    // Approve with the keyboard: the demo wallet signs, and the status screen follows.
    await approve().focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/app\/pay-run\/status/, { timeout: 30000 }).catch(() => undefined);
    walk.approvedAndShowedStatus = /\/app\/pay-run\/status/.test(page.url());
    results.keyboard.push(walk);
    void fails;
    await ctx.close();
  }

  // Fail closed: with NEAR unreachable, the proof pages say so and claim nothing.
  {
    const ctx = await context(browser, { viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await open(page, origin, "/proof");
    const proofText = await page.locator("main").innerText();
    await open(page, origin, `/verify?payout=${ITEM_DIRECT}`);
    const verifyText = await page.locator("main").innerText();
    await open(page, origin, `/verify?payout=${ITEM_PRIVATE}`);
    const privateText = await page.locator("main").innerText();
    results.failClosed = LIVE
      ? { live: true }
      : {
          proofSaysCouldntCheck: /Couldn't check right now/.test(proofText),
          proofClaimsNothing: !/follow the money|No public transaction we read/.test(proofText),
          verifyDirectSaysCouldntCheck: /Couldn't check right now/.test(verifyText),
          verifyDirectNoPass: !/Every check passed/.test(verifyText),
          verifyPrivateShowsRecordedStatus: /Status recorded by NEAR Intents/.test(privateText),
          verifyPrivateHasCondition: /Private means no public source we checked/.test(privateText),
        };
    await ctx.close();
  }

  // Reduced motion: no animations, final values.
  {
    const ctx = await context(browser, {
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    await open(page, origin, "/");
    await page.waitForTimeout(4000);
    results.motion = await page.evaluate(() => ({
      runningAnimations: document.getAnimations().filter((a) => a.playState === "running").length,
      marquee: getComputedStyle(document.querySelector(".mq-track")).animationName,
      staticFrameShown: !document.querySelector(".hero-frame")?.classList.contains("is-hidden"),
      countUpFinal: document.querySelector(".sbig span")?.textContent,
    }));
    await ctx.close();
  }

  // Responsive: no horizontal scroll; screenshots.
  for (const width of [360, 390, 768, 1024, 1440]) {
    const ctx = await context(browser, {
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    for (const [name, path] of [
      ["landing", "/"],
      ["treasury", "/app"],
      ["pay-run-review", `/app/pay-run?id=${OPEN_RUN}`],
      ["pay-run-status", `/app/pay-run/status?id=${DONE_RUN}`],
      ["privacy-proof", "/proof"],
    ]) {
      await open(page, origin, path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      results.responsive.push({ width, page: name, horizontalOverflowPx: overflow });
      await page.screenshot({ path: join(shots, `${name}-${width}.png`), fullPage: true });
    }
    await ctx.close();
  }

  // three.js only after first paint.
  {
    const ctx = await context(browser, { viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const t0 = Date.now();
    let threeAt;
    // "__THREE__" appears only in the three.js core chunk (the page chunk also names WebGLRenderer).
    page.on("response", async (r) => {
      if (!r.url().includes("/_next/static/chunks/")) return;
      const body = await r.text().catch(() => "");
      if (body.includes("__THREE__") && threeAt === undefined) threeAt = Date.now() - t0;
    });
    await page.goto(origin + "/", { waitUntil: "load" });
    await page.waitForTimeout(6000);
    const fcp = await page.evaluate(
      () => performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
    );
    results.three = {
      firstContentfulPaintMs: Math.round(fcp ?? -1),
      threeChunkLoadedMs: threeAt,
      loadedAfterFirstPaint: threeAt !== undefined && fcp !== undefined && threeAt > fcp,
    };
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

writeFileSync(join(shots, "e2e-results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

const k = (flow) => results.keyboard.find((w) => w.flow === flow) ?? {};
const t = results.tamper;
const fc = results.failClosed;
const failures = [
  ...results.axe.filter((a) => a.serious.length > 0).map((a) => `axe: ${a.page}`),
  ...results.responsive
    .filter((r) => r.horizontalOverflowPx > 0)
    .map((r) => `scroll: ${r.page}@${r.width}`),
  ...results.cspViolations,
  ...(k("sign-in").signedInAndRedirected ? [] : ["keyboard: sign-in didn't complete"]),
  ...(k("pay run review through approval").approveDisabledBeforeChecks
    ? []
    : ["approve enabled before checks"]),
  ...(k("pay run review through approval").fivePassed
    ? []
    : ["honest demo run: not all five checks passed"]),
  ...(k("pay run review through approval").approveEnabledAfterPass
    ? []
    : ["approve stayed disabled after all checks passed"]),
  ...(k("pay run review through approval").approvedAndShowedStatus
    ? []
    : ["approval didn't reach the status screen"]),
  ...(t.aFailed && t.bFailed && t.approveDisabled
    ? []
    : ["tamper: gates A and B must both fail and Approve must stay disabled"]),
  ...(t.plainWords ? [] : ["tamper: the refusal isn't in plain words"]),
  ...(t.passesAgainAfterUndo ? [] : ["tamper: undo didn't restore the passing run"]),
  ...(LIVE || Object.values(fc).every(Boolean) ? [] : [`fail-closed: ${JSON.stringify(fc)}`]),
  ...(results.three.loadedAfterFirstPaint ? [] : ["three.js didn't load after first paint"]),
];
if (failures.length) {
  console.error(`e2e: ${failures.length} failure(s)\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("e2e: pass");
