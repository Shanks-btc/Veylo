// Browser checks for the Fund screen (slice W7.3), on the demo build (out-demo), in Chrome and, with
// ENGINE=webkit, in WebKit. The founder tested the live site and clicking "Selected" on "Send USDC on
// NEAR" seemed to do nothing, and the private balance read "Unavailable / needs_session". So, at five
// sizes from 320 to 1440 px:
//
//   - with no click at all, the selected option has its panel right under it: the treasury account
//     (in full, with a QR code and a copy button), the four steps, the amount form;
//   - clicking "Selected" (or "Choose" on another option) scrolls that panel to the top of the screen;
//   - a recorded, really signed quote shows its deposit address, QR code, copy button, steps and a
//     status in words, and scrolls into view;
//   - the private balance says "Connect your wallet to see your private balance" with a button, and
//     no raw code (snake_case or SCREAMING_SNAKE) is on the page anywhere;
//   - nothing scrolls sideways or runs past the screen; axe finds nothing serious (light and dark).
//
// usage: node scripts/fund-check.mjs     (exit 0 = every check passed)
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium, webkit } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { serve } from "./serve.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const WEBKIT = process.env.ENGINE === "webkit";
const DEMO_ACCOUNT = "a87a0e4f93085edbe787aa4530021045f426c8fbc500a7c1dbd729dc4f8151ce";
const DEPOSIT = "0x11d0411de9b6c725D94aF2d24fC6A6cF4F11bE84";
const REFUND = "0xAf780910c0E7D41430D4615A437676a87a332C8C";
const RAW_CODE = /\b[a-z]{2,}(?:_[a-z]{2,})+\b|\b[A-Z]{2,}(?:_[A-Z]{2,})+\b/;

const SIZES = [
  { name: "320", viewport: { width: 320, height: 640 }, touch: true },
  { name: "375", viewport: { width: 375, height: 812 }, touch: true },
  { name: "768", viewport: { width: 768, height: 1024 }, touch: true },
  { name: "1024", viewport: { width: 1024, height: 768 }, touch: false },
  { name: "1440", viewport: { width: 1440, height: 900 }, touch: false },
];

const failures = [];
const fail = (where, what) => failures.push(`${where}: ${what}`);
const check = (where, ok, what) => {
  if (!ok) fail(where, what);
};

async function open(browser, origin, size, dark = false) {
  const ctx = await browser.newContext({
    viewport: size.viewport,
    deviceScaleFactor: size.touch ? 2 : 1,
    isMobile: size.touch && !WEBKIT ? true : false,
    hasTouch: size.touch,
    ...(dark ? { colorScheme: "dark" } : {}),
  });
  await ctx.addInitScript(
    ({ dark, account }) => {
      try {
        sessionStorage.setItem("veylo.demo.signedIn", "1");
        if (dark) localStorage.setItem(`veylo.theme.${account}`, "dark");
      } catch {
        // No storage in this context.
      }
    },
    { dark, account: DEMO_ACCOUNT },
  );
  await ctx.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort("blockedbyclient"),
  );
  if (!WEBKIT)
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => {});
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`uncaught: ${String(e.message).slice(0, 160)}`));
  await page.goto(`${origin}/app/fund`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page
    .locator("#fund-panel")
    .waitFor({ state: "visible", timeout: 15000 })
    .catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}

const rectOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
  }, selector);

async function overflow(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const out = [];
    if (document.documentElement.scrollWidth > vw + 1)
      out.push(`the page scrolls sideways (${document.documentElement.scrollWidth}px on ${vw}px)`);
    for (const el of document.querySelectorAll("#fund-panel *")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest("details:not([open]) > :not(summary)")) continue;
      if (r.right > vw + 1 || r.left < -1)
        out.push(
          `<${el.tagName.toLowerCase()}> runs past the screen (${Math.round(r.left)} to ${Math.round(r.right)} of ${vw})`,
        );
      if (out.length > 3) break;
    }
    return out;
  });
}

async function onSize(browser, origin, size) {
  const at = `fund @ ${size.name}`;
  const { ctx, page, errors } = await open(browser, origin, size);

  // 1. With no click: the selected option's panel is right there.
  const panel = page.locator("#fund-panel");
  check(at, await panel.isVisible(), "no panel under the selected option before any click");
  const panelText = (await panel.innerText().catch(() => "")) || "";
  check(
    at,
    panelText.includes("Your treasury account"),
    "the panel doesn't show the treasury account",
  );
  check(
    at,
    (await panel.locator(".copy-value", { hasText: DEMO_ACCOUNT }).count()) >= 1,
    "the treasury account isn't shown in full",
  );
  check(at, (await panel.locator("svg.qr").count()) >= 1, "no QR code in the panel");
  check(
    at,
    (await panel.getByRole("button", { name: "Copy Treasury account" }).count()) === 1,
    "no copy button for the treasury account",
  );
  check(
    at,
    (await panel.locator(".fund-steps li").count()) >= 4,
    "fewer than four steps in the panel",
  );
  check(at, (await panel.locator("#fund-amount").count()) === 1, "no amount field in the panel");
  const li = await page.evaluate(
    () => document.querySelector("#fund-panel")?.parentElement?.textContent ?? "",
  );
  check(at, /Send USDC on NEAR/.test(li), "the panel isn't inside the 'Send USDC on NEAR' option");

  // 2. The balances: words and a button, never a code.
  const body = await page.locator("main").innerText();
  check(
    at,
    body.includes("Connect your wallet to see your private balance"),
    "the private balance doesn't say what to do",
  );
  check(
    at,
    (await page.getByRole("button", { name: "Connect your wallet" }).count()) >= 1,
    "no 'Connect your wallet' button",
  );
  check(at, body.includes("Not shown yet"), "the private balance doesn't say 'Not shown yet'");
  check(
    at,
    !RAW_CODE.test(body.replace(DEMO_ACCOUNT, "")),
    `a raw code is on the page: ${RAW_CODE.exec(body)?.[0]}`,
  );

  // 3. Clicking "Selected" brings the panel to the top of the screen.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Selected" }).click();
  await page.waitForTimeout(1100);
  let r = await rectOf(page, "#fund-panel");
  const atBottom = await page.evaluate(
    () => window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2,
  );
  check(
    at,
    !!r && (r.top <= 170 || atBottom) && r.top > -r.height + 40,
    `after "Selected" the panel is at ${Math.round(r?.top ?? -1)}px, not at the top`,
  );
  for (const o of await overflow(page)) fail(at, o);

  // 4. Choosing another option opens its panel under it and scrolls to it.
  await page.getByRole("button", { name: "Choose" }).nth(1).click(); // "USDC from another chain"
  await page.waitForTimeout(1100);
  r = await rectOf(page, "#fund-panel");
  const where = await page.evaluate(
    () => document.querySelector("#fund-panel")?.parentElement?.textContent ?? "",
  );
  check(
    at,
    /USDC from another chain/.test(where),
    "the second option's panel isn't under the second option",
  );
  check(
    at,
    (await page.locator("#fund-panel").count()) === 1,
    "more than one option shows a panel",
  );
  const atBottom2 = await page.evaluate(
    () => window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2,
  );
  check(
    at,
    !!r && (r.top <= 170 || atBottom2),
    `the second option's panel is at ${Math.round(r?.top ?? -1)}px, not at the top`,
  );

  // 5. A recorded, really signed quote: the address, QR, copy button, steps; progress in words.
  await page.locator("#chain").selectOption({ label: "USDT on BNB Smart Chain" });
  await page.locator("#fund-amount").fill("2");
  await page.locator("#fund-refund").fill(REFUND);
  await page.getByRole("button", { name: "Get my deposit address" }).click();
  await page
    .getByText("Send exactly this")
    .waitFor({ timeout: 8000 })
    .catch(() => fail(at, "the quote's deposit details never appeared"));
  await page.waitForTimeout(900);
  const quote = page.locator(".fund-quote");
  check(
    at,
    (await quote.locator(".copy-value", { hasText: DEPOSIT }).count()) === 1,
    "the deposit address isn't shown in full",
  );
  check(at, (await quote.locator("svg.qr").count()) === 1, "no QR code for the deposit address");
  check(
    at,
    (await quote.getByRole("button", { name: /Copy Deposit address/ }).count()) === 1,
    "no copy button for the deposit address",
  );
  check(
    at,
    (await quote.locator(".fund-steps li").count()) === 4,
    "the quote doesn't show four steps",
  );
  const q = await rectOf(page, ".fund-quote");
  check(
    at,
    !!q && q.top < size.viewport.height && q.bottom > 0,
    "the deposit details are not on the screen after the quote",
  );
  if (!WEBKIT) {
    await quote.getByRole("button", { name: /Copy Deposit address/ }).click();
    // The label flips once the clipboard write has finished, a moment after the click.
    await quote
      .getByRole("button", { name: /Copied Deposit address/ })
      .waitFor({ timeout: 3000 })
      .catch(() => fail(at, "the copy button doesn't say Copied"));
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    check(at, clip === DEPOSIT, "the clipboard doesn't hold the deposit address");
  }
  await quote.getByRole("button", { name: /I've sent it/ }).click();
  await page
    .getByText("Waiting for your deposit")
    .waitFor({ timeout: 5000 })
    .catch(() => fail(at, "the status isn't in words"));
  const after = await page.locator("main").innerText();
  check(at, !/PENDING_DEPOSIT|PENDING DEPOSIT/.test(after), "a raw status is on the page");
  check(
    at,
    !RAW_CODE.test(after.replace(DEMO_ACCOUNT, "")),
    `a raw code is on the page: ${RAW_CODE.exec(after)?.[0]}`,
  );
  for (const o of await overflow(page)) fail(at, o);

  // 6. USDC on NEAR with a quote the demo can't sign for that route: plain words, no code.
  await page.getByRole("button", { name: "Choose" }).first().click();
  await page.waitForTimeout(500);
  await page.locator("#fund-amount").fill("1");
  await page.getByRole("button", { name: "Get my deposit address" }).click();
  await page.waitForTimeout(900);
  const refused = await page.locator("#fund-panel").innerText();
  check(
    at,
    /didn't pass the check in your browser/.test(refused),
    "a quote for the wrong asset wasn't refused in words",
  );
  check(at, !RAW_CODE.test(refused.replace(DEMO_ACCOUNT, "")), "the refusal shows a raw code");

  // The advanced direct deposit call: exact, and opens in place.
  await page.locator(".fund-advanced summary").click();
  const adv = await page.locator(".fund-advanced").innerText();
  check(
    at,
    adv.includes("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
    "the direct deposit doesn't name the USDC contract",
  );
  check(
    at,
    adv.includes("ft_transfer_call") &&
      adv.includes("intents.near") &&
      adv.includes("1 yoctoNEAR") &&
      adv.includes("100 TGas"),
    "the direct deposit call is incomplete",
  );
  check(at, adv.includes("0.1 NEAR"), "the direct deposit doesn't say how much NEAR is needed");
  check(
    at,
    adv.includes('"amount":"1000000"'),
    "the direct deposit's amount doesn't follow the amount typed",
  );
  for (const o of await overflow(page)) fail(at, `(advanced open) ${o}`);

  for (const e of errors) fail(at, e);
  await ctx.close();
}

async function axeOn(browser, origin, width, dark) {
  const at = `fund axe @ ${width}${dark ? " dark" : ""}`;
  const size = { name: String(width), viewport: { width, height: 900 }, touch: width < 600 };
  const { ctx, page } = await open(browser, origin, size, dark);
  await page.getByRole("button", { name: "Selected" }).click();
  await page.waitForTimeout(1100);
  const scan = async (what) => {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    for (const v of result.violations.filter(
      (x) => x.impact === "serious" || x.impact === "critical",
    ))
      fail(at, `${what} ${v.id} (${v.nodes.length}): ${String(v.nodes[0]?.target)}`);
  };
  await scan("panel open:");
  await page.locator(".fund-advanced summary").click();
  await page.waitForTimeout(300);
  await scan("direct deposit open:");
  await ctx.close();
  console.log(`${at}: done`);
}

const { server, origin } = await serve(0, { dir: join(web, "out-demo") });
const browser = WEBKIT
  ? await webkit.launch({ headless: true })
  : await chromium.launch({ executablePath: CHROME, headless: true });
try {
  for (const size of SIZES) {
    const before = failures.length;
    await onSize(browser, origin, size);
    console.log(
      `fund @ ${size.name}: ${failures.length === before ? "ok" : `${failures.length - before} problem(s)`}`,
    );
  }
  for (const [w, dark] of [
    [390, false],
    [1440, false],
    [390, true],
    [1440, true],
  ])
    await axeOn(browser, origin, w, dark);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log(`OK: fund screen, ${WEBKIT ? "WebKit" : "Chrome"}`);
