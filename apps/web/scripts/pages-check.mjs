// Browser checks for slice W6, on the demo build (out-demo), in the installed Chrome, with no mocked
// network (every host but this computer is refused):
//
//   crawl       visits every page and follows every link and button: a 404, a dead "#" link, a missing
//               anchor, an unhandled error or a visible "undefined" fails.
//   states      every page that loads data shows a skeleton while the API is slow, plain words and a
//               way to try again when it fails, and a designed empty state when there is nothing.
//   responsive  every page at 320, 360, 375, 390, 414, 768, 834, 1024, 1280, 1440 and 1920 px, in
//               phone landscape (844x390) and on five emulated devices: no sideways page scroll, no
//               element outside the screen, no clipped text, no overlapping buttons or links,
//               touch targets of at least 44 px on touch sizes, and the phone layout rules (bottom
//               bar, stacked cards, one-column forms, sticky actions, sheets). Screenshots of all of
//               it go to design/screenshots/responsive/.
//   axe         axe-core on every page at 390 and 1440 px, light and dark: 0 serious or critical.
//
// usage: node scripts/pages-check.mjs crawl|states|responsive|axe|all [--only=name,name]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { serve } from "./serve.mjs";
import {
  ALL_PAGES,
  DEVICES,
  EXTRA_PAGES,
  HEIGHT_FOR,
  LANDSCAPE,
  REQUIRED_PAGES,
  WIDTHS,
} from "./pages-list.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const shotsRoot = join(web, "..", "..", "design", "screenshots", "responsive");
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEMO_ACCOUNT = "a87a0e4f93085edbe787aa4530021045f426c8fbc500a7c1dbd729dc4f8151ce";

const command = process.argv[2] ?? "all";
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "")
  .slice(7)
  .split(",")
  .filter(Boolean);
const onlyConfigs = (process.argv.find((a) => a.startsWith("--configs=")) ?? "")
  .slice(10)
  .split(",")
  .filter(Boolean);
const pages = ALL_PAGES.filter((p) => only.length === 0 || only.includes(p.name));
const required = REQUIRED_PAGES.filter((p) => only.length === 0 || only.includes(p.name));

const failures = [];
const fail = (area, where, what) => failures.push({ area, where, what });

async function newContext(
  browser,
  options = {},
  { signedIn = true, mode = "", dark = false } = {},
) {
  const ctx = await browser.newContext({ ...options, ...(dark ? { colorScheme: "dark" } : {}) });
  await ctx.addInitScript(
    ({ signedIn, mode, dark, account }) => {
      try {
        if (signedIn) sessionStorage.setItem("veylo.demo.signedIn", "1");
        if (mode) sessionStorage.setItem("veylo.demo.mode", mode);
        if (dark) localStorage.setItem(`veylo.theme.${account}`, "dark");
      } catch {
        // No storage in this context.
      }
    },
    { signedIn, mode, dark, account: DEMO_ACCOUNT },
  );
  await ctx.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.continue();
    return route.abort("blockedbyclient"); // No live network.
  });
  return ctx;
}

/** Console errors that are the blocked network doing its job, not a bug. */
const EXPECTED_CONSOLE =
  /ERR_BLOCKED_BY_CLIENT|Failed to load resource|Failed to fetch|NetworkError|blocked/i;
const BAD_TEXT = /\b(undefined|NaN|\[object Object\])\b|Application error|Internal error|Unhandled/;

async function settle(page, extra = 350) {
  await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  // Data screens show a skeleton first: wait for it to go (the demo answers at once).
  await page
    .locator(".skeleton-group")
    .first()
    .waitFor({ state: "hidden", timeout: 3000 })
    .catch(() => {});
  await page.waitForTimeout(extra);
}

/** Opens a page, collecting runtime errors. Returns the main response's status. */
async function visit(page, origin, path, errors) {
  page.removeAllListeners("pageerror");
  page.removeAllListeners("console");
  page.on("pageerror", (e) => errors.push(`uncaught: ${String(e.message).slice(0, 200)}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !EXPECTED_CONSOLE.test(m.text()))
      errors.push(`console error: ${m.text().slice(0, 200)}`);
    if (/Content Security Policy|Refused to/i.test(m.text()))
      errors.push(`CSP: ${m.text().slice(0, 160)}`);
  });
  const response = await page
    .goto(origin + path, { waitUntil: "domcontentloaded", timeout: 45000 })
    .catch((e) => {
      errors.push(`could not load: ${String(e.message).slice(0, 120).replace(/\s+/g, " ")}`);
      return undefined;
    });
  await settle(page);
  return response?.status() ?? 0;
}

// ---------------------------------------------------------------------------------------------
// crawl
// ---------------------------------------------------------------------------------------------
async function crawl(browser, origin) {
  const seen = new Map(); // "path?query" -> { status, ids }
  const anchors = []; // { from, path, id }
  const queue = [...new Set(["/", ...ALL_PAGES.map((p) => p.path)])];
  const ctx = await newContext(browser, { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  let visited = 0;
  while (queue.length > 0 && visited < 200) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const errors = [];
    const status = await visit(page, origin, path, errors);
    visited += 1;
    const expected = ALL_PAGES.find((p) => p.path === path)?.status ?? 200;
    if (status !== expected) fail("crawl", path, `HTTP ${status}, expected ${expected}`);
    for (const e of errors) fail("crawl", path, e);
    const info = await page.evaluate(() => ({
      ids: [...document.querySelectorAll("[id]")].map((e) => e.id),
      hrefs: [...document.querySelectorAll("a[href]")].map((a) => ({
        href: a.getAttribute("href"),
        text: (a.textContent ?? "").trim().slice(0, 40) || a.getAttribute("aria-label") || "",
      })),
      text: document.body.innerText,
    }));
    seen.set(path, { status, ids: new Set(info.ids) });
    if (status === 200) {
      const bad = info.text.match(BAD_TEXT);
      if (bad) fail("crawl", path, `the page shows "${bad[0]}"`);
    }
    for (const { href, text } of info.hrefs) {
      const label = `${path} -> "${text}" (${href})`;
      if (href === "#" || href === "" || /^javascript:/i.test(href ?? ""))
        fail("crawl", path, `dead link: "${text}" goes nowhere (${JSON.stringify(href)})`);
      else if (/^(mailto:|tel:)/.test(href)) continue;
      else if (/^https?:\/\//.test(href) && !href.startsWith(origin))
        continue; // External: not fetched.
      else {
        const url = new URL(href, origin + path);
        const target = url.pathname + url.search;
        if (url.hash.length > 1) anchors.push({ from: label, path: target, id: url.hash.slice(1) });
        if (!seen.has(target) && !queue.includes(target)) queue.push(target);
      }
    }
  }
  for (const a of anchors) {
    const entry = seen.get(a.path);
    if (entry && entry.status === 200 && !entry.ids.has(a.id))
      fail("crawl", a.from, `the anchor #${a.id} does not exist on ${a.path}`);
  }
  await ctx.close();

  // Buttons: every button, summary and button-like control of every page, one click per fresh load.
  for (const p of pages) {
    const bctx = await newContext(
      browser,
      { viewport: { width: 1280, height: 900 } },
      { signedIn: p.signedIn !== false },
    );
    const bpage = await bctx.newPage();
    const errors = [];
    await visit(bpage, origin, p.path, errors);
    const count = await bpage
      .locator("main button:visible, main summary:visible, main [role=button]:visible")
      .count();
    let clicked = 0;
    for (let i = 0; i < count; i += 1) {
      await visit(bpage, origin, p.path, errors);
      const target = bpage
        .locator("main button:visible, main summary:visible, main [role=button]:visible")
        .nth(i);
      const label = ((await target.textContent().catch(() => "")) ?? "").trim().slice(0, 40);
      if (/sign out|log out/i.test(label)) continue;
      if (await target.isDisabled().catch(() => false)) continue;
      const before = bpage.url();
      try {
        await target.click({ timeout: 2500, trial: false });
      } catch {
        continue; // Not clickable (covered or gone): the responsive check owns that.
      }
      clicked += 1;
      await bpage.waitForTimeout(250);
      if (bpage.url() !== before) {
        const nav = new URL(bpage.url());
        if (nav.origin === origin) {
          const res = await bctx.request.get(nav.href).catch(() => undefined);
          if (!res || res.status() >= 400)
            fail(
              "crawl",
              p.path,
              `the button "${label}" leads to ${nav.pathname}, HTTP ${res?.status()}`,
            );
        }
      }
      const text = await bpage.evaluate(() => document.body.innerText).catch(() => "");
      const bad = text.match(BAD_TEXT);
      if (bad) fail("crawl", p.path, `after "${label}" the page shows "${bad[0]}"`);
    }
    for (const e of new Set(errors)) fail("crawl", p.path, `${e} (while clicking buttons)`);
    console.log(`crawl: ${p.name}: ${clicked}/${count} controls clicked`);
    await bctx.close();
  }
  console.log(`crawl: ${visited} pages visited by following links`);
}

// ---------------------------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------------------------
async function states(browser, origin) {
  for (const p of required) {
    const signedIn = p.signedIn !== false;
    // Success: the page's own content, no error, no skeleton left.
    {
      const ctx = await newContext(
        browser,
        { viewport: { width: 1280, height: 900 } },
        { signedIn },
      );
      const page = await ctx.newPage();
      const errors = [];
      await visit(page, origin, p.path, errors);
      await page.waitForTimeout(600);
      if ((await page.locator("h1").count()) === 0)
        fail("states", p.name, "success: the page has no heading");
      if (
        (await page.locator(".error-note:visible").count()) > 0 &&
        !p.path.startsWith("/proof") &&
        !p.path.startsWith("/verify") &&
        !p.path.includes("privacy-proof")
      )
        fail("states", p.name, "success: an error shows on a normal load");
      if ((await page.locator(".skeleton-group:visible").count()) > 0)
        fail("states", p.name, "success: a skeleton is still showing");
      await ctx.close();
    }
    if (!p.states) continue;
    if (p.states.loading) {
      const ctx = await newContext(
        browser,
        { viewport: { width: 1280, height: 900 } },
        { signedIn, mode: "slow" },
      );
      const page = await ctx.newPage();
      await page.goto(origin + p.path, { waitUntil: "domcontentloaded" });
      const ok = await page
        .locator(".skeleton-group")
        .first()
        .waitFor({ state: "visible", timeout: 3000 })
        .then(
          () => true,
          () => false,
        );
      if (!ok) fail("states", p.name, "loading: no skeleton while the API is slow");
      await ctx.close();
    }
    if (p.states.error) {
      const ctx = await newContext(
        browser,
        { viewport: { width: 1280, height: 900 } },
        { signedIn, mode: "fail" },
      );
      const page = await ctx.newPage();
      const errors = [];
      await visit(page, origin, p.path, errors);
      const note = page.locator(".error-note").first();
      const ok = await note.waitFor({ state: "visible", timeout: 6000 }).then(
        () => true,
        () => false,
      );
      if (!ok) fail("states", p.name, "error: no error message when the API fails");
      else {
        const text = ((await note.textContent()) ?? "").trim();
        if (text.length < 15 || /[{}]|UNAVAILABLE|TypeError|undefined|\[object/.test(text))
          fail("states", p.name, `error: not in plain words: "${text.slice(0, 80)}"`);
        const retry = await page.getByRole("button", { name: /try again/i }).count();
        if (retry === 0 && !/try again|check your connection|refresh|reload/i.test(text))
          fail("states", p.name, "error: no way to try again");
      }
      for (const e of errors.filter((x) => x.startsWith("uncaught")))
        fail("states", p.name, `error mode: ${e}`);
      await ctx.close();
    }
    if (p.states.empty) {
      const ctx = await newContext(
        browser,
        { viewport: { width: 1280, height: 900 } },
        { signedIn, mode: "empty" },
      );
      const page = await ctx.newPage();
      await visit(page, origin, p.path, []);
      const ok = await page
        .getByText(p.states.empty)
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .then(
          () => true,
          () => false,
        );
      if (!ok) fail("states", p.name, `empty: no designed empty state (${p.states.empty})`);
      await ctx.close();
    }
    console.log(`states: ${p.name}: ${Object.keys(p.states).join(", ")} checked`);
  }
}

// ---------------------------------------------------------------------------------------------
// responsive
// ---------------------------------------------------------------------------------------------
/** Runs in the page. `touch` turns on the 44 px rule. Returns a list of plain-words problems. */
function measure({ touch, phone }) {
  const issues = [];
  const doc = document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (doc.scrollWidth > vw + 1)
    issues.push(
      `the page scrolls sideways (content is ${doc.scrollWidth}px wide on a ${vw}px screen)`,
    );

  const label = (el) => {
    const t = (el.getAttribute("aria-label") || el.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 36);
    return `<${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""}> "${t}"`;
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
      if (p.tagName === "DIALOG" && !p.open) return false;
      if (p.getAttribute("aria-hidden") === "true") return false;
      if (p.hasAttribute("inert")) return false;
      if (p.tagName === "DETAILS" && !p.open && !el.closest("summary")) return false;
    }
    return true;
  };
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) {
        const pr = p.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.right > pr.right + 1 || r.left < pr.left - 1) return true;
      }
    }
    return false;
  };
  const fixedAncestor = (el) => {
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const pos = getComputedStyle(p).position;
      if (pos === "fixed" || pos === "sticky") return p;
    }
    return undefined;
  };

  // Outside the screen.
  const SKIP = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "HEAD",
    "META",
    "LINK",
    "BR",
    "WBR",
    "PATH",
    "G",
    "DEFS",
    "USE",
    "CIRCLE",
    "RECT",
    "LINE",
    "POLYGON",
    "POLYLINE",
    "ELLIPSE",
    "STOP",
    "LINEARGRADIENT",
    "SYMBOL",
    "CLIPPATH",
    "TSPAN",
  ]);
  let outside = 0;
  for (const el of document.body.querySelectorAll("*")) {
    if (
      SKIP.has(el.tagName.toUpperCase()) ||
      (el.closest("svg") !== null && el.tagName.toLowerCase() !== "svg")
    )
      continue;
    if (el.closest(".sr-only, .skip-link")) continue;
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      if (inScroller(el)) continue;
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" && (r.right > vw + 1 || r.left < -1) === false) continue;
      if (outside < 5)
        issues.push(
          `${label(el)} reaches outside the screen (${Math.round(r.left)} to ${Math.round(r.right)} on a ${vw}px screen)`,
        );
      outside += 1;
    }
  }
  if (outside > 5) issues.push(`...and ${outside - 5} more elements outside the screen`);

  // Clipped text.
  for (const el of document.body.querySelectorAll("*")) {
    if (SKIP.has(el.tagName.toUpperCase()) || el.closest("svg")) continue;
    const cs = getComputedStyle(el);
    if (!/(hidden|clip)/.test(cs.overflowX + cs.overflowY)) continue;
    if (el.closest(".sr-only, .skeleton, .skeleton-group")) continue;
    if (!shown(el)) continue;
    if (!(el.textContent || "").trim()) continue;
    if (el.matches("details, dialog, body, html")) continue;
    const box = el.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (
        !n.textContent.trim() ||
        n.parentElement?.closest('[aria-hidden="true"], .sr-only, .marquee')
      )
        continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const sideways =
        /(hidden|clip)/.test(cs.overflowX) && (r.right > box.right + 2 || r.left < box.left - 2);
      const down =
        /(hidden|clip)/.test(cs.overflowY) && (r.bottom > box.bottom + 2 || r.top < box.top - 2);
      if (sideways || down) {
        issues.push(
          `${label(el)} cuts its text off ${sideways ? "sideways" : "at the bottom"}: "${n.textContent.trim().slice(0, 30)}"`,
        );
        break;
      }
    }
  }

  // Interactive elements.
  const interactive = [
    ...document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"]',
    ),
  ].filter((el) => !el.closest(".skip-link, .sr-only") && shown(el));
  if (touch) {
    for (const el of interactive) {
      const cs = getComputedStyle(el);
      let target = el;
      if (el.matches('input[type="checkbox"], input[type="radio"]'))
        target =
          el.closest("label") ??
          (el.id ? document.querySelector(`label[for="${el.id}"]`) : null) ??
          el;
      if (el.tagName === "A" && cs.display === "inline") continue; // A link inside a sentence.
      if (el.closest("p, li, dd") && cs.display === "inline") continue;
      const r = target.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5)
        issues.push(
          `${label(el)} is a ${Math.round(r.width)}x${Math.round(r.height)}px target (44px needed)`,
        );
    }
  }
  const overlap = (list, report) => {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (w > 4 && h > 4 && w * h > 24) report(`${label(a)} overlaps ${label(b)}`);
      }
    }
  };
  const flowing = interactive.filter((el) => !fixedAncestor(el));
  let overlaps = 0;
  overlap(flowing, (m) => {
    if (overlaps < 5) issues.push(m);
    overlaps += 1;
  });

  // Phone layout rules.
  if (phone) {
    for (const table of document.querySelectorAll("table")) {
      if (!shown(table)) continue;
      const head = table.querySelector("thead");
      if (head && shown(head) && getComputedStyle(head).position !== "absolute")
        issues.push(
          `a table still shows its header row on a phone (it should be stacked cards): "${(table.querySelector("caption")?.textContent ?? "").trim().slice(0, 30)}"`,
        );
    }
    for (const form of document.querySelectorAll("form.form, .form")) {
      const controls = [
        ...form.querySelectorAll(
          "input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea",
        ),
      ].filter(shown);
      for (let i = 0; i < controls.length; i += 1)
        for (let j = i + 1; j < controls.length; j += 1) {
          const a = controls[i].getBoundingClientRect();
          const b = controls[j].getBoundingClientRect();
          const sameBand = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 8;
          if (sameBand)
            issues.push(
              `a form shows two fields side by side on a phone: ${label(controls[i])} and ${label(controls[j])}`,
            );
        }
    }
    const sidebar = document.querySelector(".sidebar");
    if (sidebar && shown(sidebar)) {
      const r = sidebar.getBoundingClientRect();
      if (r.bottom < vh - 2 || r.top < vh * 0.5)
        issues.push(
          `the app menu is not a bottom bar on a phone (top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)} of ${vh})`,
        );
    }
    for (const bar of document.querySelectorAll(".sticky-actions")) {
      if (!shown(bar)) continue;
      const pos = getComputedStyle(bar).position;
      if (pos !== "sticky" && pos !== "fixed")
        issues.push(`the action bar does not stick to the screen on a phone (${label(bar)})`);
    }
  } else {
    const sidebar = document.querySelector(".sidebar");
    if (sidebar && shown(sidebar)) {
      const r = sidebar.getBoundingClientRect();
      if (r.left > 4 && vw >= 1024)
        issues.push(
          `the app menu is not on the left on a wide screen (left ${Math.round(r.left)})`,
        );
    }
  }
  return issues;
}

/** Scrolls to the bottom and checks nothing is left behind a fixed or sticky bar. */
function measureBottom() {
  const issues = [];
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  const label = (el) =>
    `<${el.tagName.toLowerCase()}> "${(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30)}"`;
  const bars = [
    ...document.querySelectorAll(".sticky-actions, .sidebar, .app-nav, .drawer"),
  ].filter((b) => {
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return (
      (cs.position === "fixed" || cs.position === "sticky") &&
      r.width > 0 &&
      r.height > 0 &&
      cs.display !== "none"
    );
  });
  const targets = [
    ...document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary',
    ),
  ].filter((el) => {
    const r = el.getBoundingClientRect();
    const closed = el.closest("details:not([open])");
    return (
      r.width > 0 &&
      r.height > 0 &&
      !el.closest(".skip-link, .sr-only") &&
      !bars.some((b) => b.contains(el)) &&
      getComputedStyle(el).visibility !== "hidden" &&
      !(closed && !el.closest("summary"))
    );
  });
  for (const bar of bars) {
    const br = bar.getBoundingClientRect();
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      const w = Math.min(br.right, r.right) - Math.max(br.left, r.left);
      const h = Math.min(br.bottom, r.bottom) - Math.max(br.top, r.top);
      if (
        w > 4 &&
        h > 4 &&
        el.closest("dialog:not([open])") === null &&
        r.top < window.innerHeight &&
        r.bottom > 0
      )
        issues.push(
          `at the bottom of the page ${label(el)} is hidden behind the bar ${label(bar)}`,
        );
    }
  }
  return issues.slice(0, 5);
}

async function responsive(browser, origin) {
  rmSync(shotsRoot, { recursive: true, force: true });
  mkdirSync(shotsRoot, { recursive: true });
  const configs = [
    ...WIDTHS.map((w) => ({
      name: `w${w}`,
      options: { viewport: { width: w, height: HEIGHT_FOR(w) } },
      touch: w <= 834,
      phone: w <= 640,
    })),
    {
      name: "phone-landscape-844x390",
      options: { viewport: LANDSCAPE, hasTouch: true },
      touch: true,
      phone: false,
    },
    ...DEVICES.map((d) => ({
      name: `device-${d.name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`,
      options: d.descriptor ? { ...devices[d.descriptor] } : { viewport: d.viewport },
      touch: Boolean(d.descriptor),
      phone: Boolean(d.descriptor) && (devices[d.descriptor]?.viewport?.width ?? 1000) <= 640,
    })),
  ];
  const grid = {}; // page -> config -> "ok" | issues
  const runConfig = async (cfg) => {
    const dir = join(shotsRoot, cfg.name);
    mkdirSync(dir, { recursive: true });
    const signed = await newContext(browser, cfg.options, { signedIn: true });
    const visitor = await newContext(browser, cfg.options, { signedIn: false });
    const spage = await signed.newPage();
    const vpage = await visitor.newPage();
    for (const p of pages) {
      const page = p.signedIn === false ? vpage : spage;
      const errors = [];
      await visit(page, origin, p.path, errors);
      await page.waitForTimeout(250);
      const issues = await page.evaluate(measure, { touch: cfg.touch, phone: cfg.phone });
      issues.push(...(await page.evaluate(measureBottom)));
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      for (const e of errors.filter(
        (x) => x.startsWith("uncaught") || x.startsWith("could not load"),
      ))
        issues.push(e);
      try {
        await page.screenshot({
          path: join(dir, `${p.name}.jpg`),
          fullPage: true,
          type: "jpeg",
          quality: 55,
        });
      } catch (err) {
        issues.push(`screenshot failed: ${String(err.message).slice(0, 80)}`);
      }
      (grid[p.name] ??= {})[cfg.name] = issues.length === 0 ? "ok" : issues;
      for (const i of issues) fail("responsive", `${p.name} @ ${cfg.name}`, i);
    }
    await signed.close();
    await visitor.close();
    console.log(`responsive: ${cfg.name} done`);
  };
  // A few configurations at a time.
  const queue = configs.filter((c) => onlyConfigs.length === 0 || onlyConfigs.includes(c.name));
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let cfg = queue.shift(); cfg; cfg = queue.shift()) await runConfig(cfg);
    }),
  );
  // The results table: page x width.
  const cols = configs.map((c) => c.name);
  const lines = [
    "# Responsive results",
    "",
    `Pages: ${pages.length}. Sizes: ${cols.length}. A dot is a pass; a number is how many problems (listed in the report below the table).`,
    "",
    `| page | ${cols.join(" | ")} |`,
    `| --- | ${cols.map(() => "---").join(" | ")} |`,
    ...pages.map(
      (p) =>
        `| ${p.name} | ${cols.map((c) => (grid[p.name]?.[c] === "ok" ? "·" : String(grid[p.name]?.[c]?.length ?? "?"))).join(" | ")} |`,
    ),
  ];
  const problems = failures.filter((f) => f.area === "responsive");
  if (problems.length > 0)
    lines.push("", "## Problems", "", ...problems.map((f) => `- ${f.where}: ${f.what}`));
  writeFileSync(join(shotsRoot, "results.md"), lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------------------------
// axe
// ---------------------------------------------------------------------------------------------
async function axe(browser, origin) {
  for (const [width, dark] of [
    [390, false],
    [1440, false],
    [390, true],
    [1440, true],
  ]) {
    const signed = await newContext(
      browser,
      { viewport: { width, height: HEIGHT_FOR(width) } },
      { signedIn: true, dark },
    );
    const visitor = await newContext(
      browser,
      { viewport: { width, height: HEIGHT_FOR(width) } },
      { signedIn: false, dark },
    );
    const spage = await signed.newPage();
    const vpage = await visitor.newPage();
    for (const p of pages) {
      const page = p.signedIn === false ? vpage : spage;
      await visit(page, origin, p.path, []);
      await page.waitForTimeout(300);
      const r = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      for (const v of bad)
        fail(
          "axe",
          `${p.name} @ ${width}${dark ? " dark" : ""}`,
          `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target}`,
        );
    }
    console.log(`axe: ${width}px ${dark ? "dark" : "light"} done`);
    await signed.close();
    await visitor.close();
  }
}

// ---------------------------------------------------------------------------------------------
// E2E_ORIGIN points the checks at a running dev server instead (fast CSS iteration only; the real
// run is against the production demo build).
const external = process.env.E2E_ORIGIN;
const { server, origin } = external
  ? { server: { close() {} }, origin: external }
  : await serve(0, { dir: join(web, "out-demo") });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const all = command === "all";
  if (all || command === "crawl") await crawl(browser, origin);
  if (all || command === "states") await states(browser, origin);
  if (all || command === "responsive") await responsive(browser, origin);
  if (all || command === "axe") await axe(browser, origin);
} finally {
  await browser.close();
  server.close();
}

const byArea = {};
for (const f of failures) (byArea[f.area] ??= []).push(f);
for (const [area, list] of Object.entries(byArea)) {
  console.log(`\nFAIL ${area}: ${list.length}`);
  for (const f of list.slice(0, 60)) console.log(`  ${f.where}: ${f.what}`);
  if (list.length > 60) console.log(`  ...and ${list.length - 60} more`);
}
console.log(
  failures.length === 0
    ? `\nOK: ${command}, ${pages.length} pages`
    : `\n${failures.length} problems`,
);
process.exit(failures.length === 0 ? 0 : 1);
