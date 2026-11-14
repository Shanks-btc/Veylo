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
//   landing     (slice W7) the landing page at all 17 sizes, light and dark: nothing overlaps, clips, pins
//               or scrolls sideways; the drawer opened, tabbed, closed by Escape, backdrop, link and
//               button, with and without reduced motion; axe at 390 and 1440 with the drawer open.
// usage: node scripts/pages-check.mjs crawl|states|responsive|axe|landing|all [--only=name,name]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright-core";
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
const WEBKIT = process.env.ENGINE === "webkit";
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

/** The 17 sizes: 11 widths, phone landscape, and five emulated devices. */
function sizeConfigs() {
  return [
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
}

async function responsive(browser, origin) {
  rmSync(shotsRoot, { recursive: true, force: true });
  mkdirSync(shotsRoot, { recursive: true });
  const configs = sizeConfigs();
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
// landing (slice W7): the landing page at all 17 sizes, light and dark, with the drawer open
// ---------------------------------------------------------------------------------------------
/** What must hold on the landing page itself, beyond the checks every page gets (measure). */
function landingChecks({ vw }) {
  const issues = [];
  const px = (v) => +String(v).replace("px", "");
  const rect = (el) => el.getBoundingClientRect();
  const label = (el) =>
    `<${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).split(" ")[0]}>`;
  const overlap = (a, b) => {
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return x > 1 && y > 1;
  };
  // Nothing is pinned or scroll-linked on the page (only the floating navigation is fixed, and it is
  // outside main).
  for (const el of document.querySelectorAll("main *")) {
    if (getComputedStyle(el).position === "sticky") issues.push(`${label(el)} is position: sticky`);
  }
  // Text is never clipped: a block that hides overflow must not hide any of its own text.
  for (const el of document.querySelectorAll(
    "main :is(h1,h2,h3,p,li,span,a,small,strong,dt,dd):not(svg *)",
  )) {
    const cs = getComputedStyle(el);
    if (!/(hidden|clip)/.test(cs.overflowX + cs.overflowY)) continue;
    if (cs.textOverflow === "ellipsis") continue; // A name on one line, shortened on purpose.
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      issues.push(`${label(el)} clips its text`);
  }

  // The hero: one solid button and a quiet link; no chips; the panel; the trust line.
  const hero = document.querySelector("#top");
  if (hero) {
    const parts = [
      ...hero.querySelectorAll("h1, .hero-lede, .cta, .hp-frame, .hp-caption, .trust-line"),
    ];
    for (let i = 0; i < parts.length; i += 1)
      for (let j = i + 1; j < parts.length; j += 1)
        if (overlap(rect(parts[i]), rect(parts[j])))
          issues.push(`in the hero ${label(parts[i])} overlaps ${label(parts[j])}`);
    // The subline: two lines on a desktop and a tablet (the break is on from 768px), a natural wrap on
    // a phone.
    const lede = hero.querySelector(".hero-lede");
    if (lede) {
      const lh = px(getComputedStyle(lede).lineHeight) || px(getComputedStyle(lede).fontSize) * 1.5;
      const lines = Math.round(rect(lede).height / lh);
      if (vw >= 768 && lines !== 2) issues.push(`the subline is ${lines} lines at ${vw}px, not 2`);
      if (vw < 768 && lines > 4) issues.push(`the subline is ${lines} lines on a phone`);
      const br = lede.querySelector(".hero-br");
      if ((getComputedStyle(br).display === "none") !== vw < 768)
        issues.push("the subline's line break is wrong for this width");
    }
    if (hero.querySelectorAll(".btn").length !== 1)
      issues.push(`the hero has ${hero.querySelectorAll(".btn").length} buttons, not 1`);
    for (const gone of [".chips", ".chip", ".pchip", ".proof-row", ".pv", ".preview"])
      if (hero.querySelector(gone)) issues.push(`the hero still has ${gone}`);
    const link = hero.querySelector(".hero-link");
    if (!link) issues.push("the hero has no 'See how it works' link");
    else {
      const cs = getComputedStyle(link);
      if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") issues.push("the hero text link has a fill");
      if (px(cs.borderTopWidth) > 0) issues.push("the hero text link has a border");
      if (rect(link).height < 43.5)
        issues.push(`the hero text link is ${Math.round(rect(link).height)}px tall`);
    }
    const trust = hero.querySelector(".trust-line");
    if (trust) {
      const cs = getComputedStyle(trust);
      if (px(cs.borderTopWidth) > 0 || cs.backgroundColor !== "rgba(0, 0, 0, 0)")
        issues.push("the trust line has a border or a fill");
      if (trust.querySelectorAll("a").length !== 1)
        issues.push("the trust line does not have exactly one link");
      if (trust.querySelector("button, li")) issues.push("the trust line has controls in it");
      if (rect(trust).top < rect(hero.querySelector(".hp-caption")).bottom - 1)
        issues.push("the trust line is not below the sample workspace");
    } else issues.push("the hero has no trust line");

    const cards = [...hero.querySelectorAll(".hp-card")];
    if (cards.length !== 3) issues.push(`the panel has ${cards.length} cards, not 3`);
    const [treasury, run, section, payslip] = [
      hero.querySelector(".hp-treasury"),
      hero.querySelector(".hp-run"),
      hero.querySelector(".hp-contractor"),
      hero.querySelector(".private-card"),
    ];
    const frame = hero.querySelector(".hp-frame");
    for (const c of cards) {
      const r = rect(c);
      if (r.width < 200) issues.push(`a panel card is only ${Math.round(r.width)}px wide`);
      if (r.right > rect(frame).right + 1 || r.left < rect(frame).left - 1)
        issues.push("a panel card leaves its frame");
    }
    for (let i = 0; i < cards.length; i += 1)
      for (let j = i + 1; j < cards.length; j += 1)
        if (overlap(rect(cards[i]), rect(cards[j]))) issues.push("two panel cards overlap");
    if (treasury && run && section && payslip) {
      const t = rect(treasury);
      const r = rect(run);
      const c = rect(section);
      const p = rect(payslip);
      if (vw >= 1024) {
        if (!(t.right <= r.left + 1 && t.right <= c.left + 1))
          issues.push(
            "on a desktop the treasury is not beside the pay run and the contractor card",
          );
        if (!(r.bottom <= c.top + 1))
          issues.push("on a desktop the pay run is not above the contractor card");
        // Both columns end at the same height.
        if (Math.abs(t.bottom - c.bottom) > 1.5)
          issues.push(
            `the two columns end ${Math.round(Math.abs(t.bottom - c.bottom))}px apart (treasury ${Math.round(t.bottom)}, contractor card ${Math.round(c.bottom)})`,
          );
        // About 7/12 and 5/12 of the panel's width.
        const share = t.width / (t.width + r.width);
        if (share < 0.54 || share > 0.62)
          issues.push(`the treasury is ${Math.round(share * 100)}% wide, not about 58%`);
      } else {
        if (!(t.bottom <= r.top + 1 && r.bottom <= c.top + 1))
          issues.push("below 1024px the cards are not stacked treasury, pay run, contractor card");
        if (Math.abs(t.width - r.width) > 2 || Math.abs(r.width - c.width) > 2)
          issues.push("below 1024px the cards are not the same width");
      }
      // The payslip card is a compact inset card inside its labelled section: about 170px tall on a
      // desktop and a tablet (never a tall card, even at 768px), a little more on a narrow phone
      // where its note wraps.
      if (!(rect(section.querySelector(".hp-eye")).bottom <= p.top + 1))
        issues.push("the 'Contractor card' label is not above the payslip card");
      if (p.left < c.left || p.right > c.right) issues.push("the payslip card leaves its section");
      if (vw >= 360 && p.height > 185)
        issues.push(`the payslip card is ${Math.round(p.height)}px tall, over 185px`);
      if (p.height > 235)
        issues.push(`the payslip card is ${Math.round(p.height)}px tall on a phone`);
      if (p.width > 441)
        issues.push(`the payslip card is ${Math.round(p.width)}px wide, not compact`);
      // No large empty space inside it: the gap between its rows stays small.
      const rows = [...payslip.querySelectorAll(".pc-top, .pc-mid, .pc-bot")].map(rect);
      for (let i = 1; i < rows.length; i += 1)
        if (rows[i].top - rows[i - 1].bottom > 20)
          issues.push("the payslip card has a large empty space between its rows");
      if (p.bottom - rows[rows.length - 1].bottom > 24)
        issues.push("the payslip card has empty space at the bottom");
    }
    // No tall empty card anywhere in the panel: inside each card, going down, no stretch of the card is
    // covered by nothing for more than 72px (the treasury card on a desktop spreads its parts out
    // evenly to match the right column, which stays under that), and nothing is left under the last part.
    for (const card of cards) {
      const kids = [...card.children]
        .filter((k) => !k.classList.contains("glare"))
        .map(rect)
        .sort((a, b) => a.top - b.top);
      let covered = kids[0].bottom;
      for (const k of kids.slice(1)) {
        if (k.top - covered > 72)
          issues.push(
            `${label(card)} has ${Math.round(k.top - covered)}px of empty space inside it`,
          );
        covered = Math.max(covered, k.bottom);
      }
      const bottomSpace = rect(card).bottom - covered;
      if (bottomSpace > 44)
        issues.push(`${label(card)} has ${Math.round(bottomSpace)}px of empty space at its bottom`);
    }
    // The three stat tiles are in a row, or in one column on a narrow card.
    const tiles = [...hero.querySelectorAll(".hp-tile")].map(rect);
    if (tiles.length !== 3) issues.push(`the treasury has ${tiles.length} stat tiles, not 3`);
    else {
      const sameRow = tiles.every((t) => Math.abs(t.top - tiles[0].top) < 2);
      const oneColumn = tiles.every((t) => Math.abs(t.left - tiles[0].left) < 2);
      if (!sameRow && !oneColumn)
        issues.push("the stat tiles are neither in a row nor in a column");
      if (vw < 400 && !oneColumn) issues.push("under 400px the stat tiles are not one column");
      if (vw >= 1024 && !sameRow) issues.push("on a desktop the stat tiles are not in a row");
    }
    for (const tile of hero.querySelectorAll(
      ".hp-tile dd, .hp-amount, .pc-amount, .pc-note, .pc-name, .pc-sub",
    )) {
      if (tile.scrollWidth > tile.clientWidth + 1 && getComputedStyle(tile).display !== "inline")
        issues.push(`${label(tile)} is wider than its box`);
    }
    // The balance has settled on its final value by now (it counts up once and stops).
    const amount = hero.querySelector(".hp-amount .hp-final");
    if (amount && amount.textContent !== "$248,420.50")
      issues.push(`the balance reads ${amount.textContent}`);
    const caption = hero.querySelector(".hp-caption");
    if (caption && caption.textContent !== "Sample workspace")
      issues.push("the caption is not 'Sample workspace'");
    // Nothing in the panel can be clicked.
    if (hero.querySelector(".hp a, .hp button"))
      issues.push("something in the sample workspace is clickable");
  }

  // Problem and solution (the earlier design): three cards in a row (one column at 980px and below),
  // the same height, none overlapping, on the light page; the heading is the relaxed size.
  for (const id of ["problem", "solution"]) {
    const sec = document.querySelector(`#${id}`);
    const cards = [...document.querySelectorAll(`#${id} .pitch .card`)].map(rect);
    if (cards.length !== 3) issues.push(`#${id} has ${cards.length} cards, not 3`);
    for (let i = 0; i < cards.length; i += 1)
      for (let j = i + 1; j < cards.length; j += 1)
        if (overlap(cards[i], cards[j])) issues.push(`two cards in #${id} overlap`);
    if (cards.length === 3) {
      const row = cards.every((c) => Math.abs(c.top - cards[0].top) < 2);
      const column = cards.every((c, i) => i === 0 || c.top >= cards[i - 1].bottom - 1);
      if (vw > 980 && !row) issues.push(`the cards in #${id} are not in a row`);
      if (vw <= 980 && !column) issues.push(`the cards in #${id} are not one under another`);
      if (row && cards.some((c) => Math.abs(c.height - cards[0].height) > 1.5))
        issues.push(`the cards in #${id} are not the same height`);
    }
    const h2 = sec?.querySelector("h2");
    if (h2) {
      const cs = getComputedStyle(h2);
      if (px(cs.fontSize) < 31.9 || px(cs.fontSize) > 48.1)
        issues.push(`#${id} heading is ${cs.fontSize}`);
      if (Math.abs(px(cs.lineHeight) / px(cs.fontSize) - 1.15) > 0.01)
        issues.push(`#${id} heading line height is ${cs.lineHeight}`);
      if (Math.abs(px(cs.letterSpacing) / px(cs.fontSize) + 0.01) > 0.002)
        issues.push(`#${id} heading letter spacing is ${cs.letterSpacing}`);
    }
    // Light, like the page: no dark band, no connector, nothing sticky.
    if (sec && getComputedStyle(sec).backgroundColor !== "rgba(0, 0, 0, 0)")
      issues.push(`#${id} has a background of its own`);
  }
  if (document.querySelector(".fixes, .pitch-lead, .pitch-dark"))
    issues.push("a W7.1 problem/solution leftover is on the page");

  // One container and one left edge: every section (the hero is centred by design) has the same
  // container width and starts its eyebrow, heading, intro and content at the same left edge.
  const ids = ["problem", "solution", "how", "product", "story", "who", "faq", "start"];
  const wraps = ids.map((id) => document.querySelector(`#${id} > .wrap`)).filter(Boolean);
  if (wraps.length !== ids.length)
    issues.push(`${wraps.length} of ${ids.length} sections have a container`);
  const edge = (w) => rect(w).left + px(getComputedStyle(w).paddingLeft);
  const inner = (w) =>
    rect(w).width - px(getComputedStyle(w).paddingLeft) - px(getComputedStyle(w).paddingRight);
  for (const w of wraps) {
    if (Math.abs(rect(w).width - rect(wraps[0]).width) > 0.5)
      issues.push(
        `#${w.parentElement.id} container is ${Math.round(rect(w).width)}px wide, not ${Math.round(rect(wraps[0]).width)}px`,
      );
    if (Math.abs(edge(w) - edge(wraps[0])) > 0.5)
      issues.push(
        `#${w.parentElement.id} container starts at ${Math.round(edge(w))}px, not ${Math.round(edge(wraps[0]))}px`,
      );
    for (const el of w.children) {
      if (getComputedStyle(el).display === "none") continue;
      if (Math.abs(rect(el).left - edge(w)) > 1)
        issues.push(
          `in #${w.parentElement.id} <${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}> starts ${Math.round(rect(el).left - edge(w))}px off the left edge`,
        );
      if (rect(el).right > edge(w) + inner(w) + 1)
        issues.push(
          `in #${w.parentElement.id} <${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}> runs past the right edge of the container`,
        );
    }
  }
  const foot = document.querySelector(".footer > .wrap");
  if (foot && Math.abs(edge(foot) - edge(wraps[0])) > 0.5)
    issues.push("the footer does not start at the container's left edge");
  // Sections come in the new order.
  const order = ["top", "problem", "solution", "how", "product", "story", "who", "faq", "start"];
  const tops = order.map(
    (id) => document.getElementById(id)?.getBoundingClientRect().top + window.scrollY,
  );
  if (tops.some((t, i) => !(t >= 0) || (i > 0 && t <= tops[i - 1])))
    issues.push(`the sections are not in order ${order.join(", ")}`);

  // How it works: four steps (a row, two by two, or one by one) and one diagram that fits.
  const how = document.querySelector("#how");
  if (how) {
    const steps = [...how.querySelectorAll(".how-step")].map(rect);
    if (steps.length !== 4) issues.push(`how it works has ${steps.length} steps, not 4`);
    else {
      const row = steps.every((s) => Math.abs(s.top - steps[0].top) < 2);
      const column = steps.every((s, i) => i === 0 || s.top >= steps[i - 1].bottom - 1);
      if (vw >= 1024 && !row) issues.push("on a desktop the four steps are not in a row");
      if (vw < 600 && !column) issues.push("on a phone the four steps are not one under another");
      for (let i = 0; i < 4; i += 1)
        for (let j = i + 1; j < 4; j += 1)
          if (overlap(steps[i], steps[j])) issues.push("two steps overlap");
    }
    const shown = [...how.querySelectorAll(".tree svg")].filter(
      (s) => getComputedStyle(s).display !== "none",
    );
    if (shown.length !== 1) issues.push(`${shown.length} diagrams are showing, not 1`);
    const svg = shown[0];
    if (svg) {
      const tree = how.querySelector(".tree");
      const t = rect(tree);
      const s = rect(svg);
      if (s.left < t.left - 1 || s.right > t.right + 1) issues.push("the diagram leaves its box");
      if (tree.scrollWidth > tree.clientWidth + 1) issues.push("the diagram box scrolls sideways");
      const vertical = svg.classList.contains("tree-tall");
      if (vertical !== vw < 900)
        issues.push(`the ${vertical ? "vertical" : "horizontal"} diagram is showing at ${vw}px`);
      // Every node and label is inside the drawing, and inside the screen.
      const box = svg.viewBox.baseVal;
      for (const el of svg.querySelectorAll("rect, text, circle")) {
        const b = el.getBBox();
        if (
          b.x < box.x - 0.5 ||
          b.y < box.y - 0.5 ||
          b.x + b.width > box.width + 0.5 ||
          b.y + b.height > box.height + 0.5
        )
          issues.push(
            `a ${el.tagName} (${(el.textContent || "").trim().slice(0, 18)}) is outside the drawing`,
          );
        const r = rect(el);
        if (r.right > vw + 0.5 || r.left < -0.5)
          issues.push(
            `a ${el.tagName} (${(el.textContent || "").trim().slice(0, 18)}) is cut off at the edge of the screen`,
          );
      }
      // A label is wider than neither its node nor the drawing: text fits inside the pill behind it.
      for (const g of svg.querySelectorAll("g.node")) {
        const rects = [...g.querySelectorAll("rect")];
        for (const t2 of g.querySelectorAll("text")) {
          const tb = t2.getBBox();
          const holder = rects.find((r2) => {
            const rb = r2.getBBox();
            return (
              tb.x >= rb.x - 0.5 &&
              tb.x + tb.width <= rb.x + rb.width + 0.5 &&
              tb.y >= rb.y - 0.5 &&
              tb.y + tb.height <= rb.y + rb.height + 0.5
            );
          });
          if (
            rects.length &&
            !holder &&
            !g.querySelector("circle") &&
            (t2.textContent || "").trim().length > 0
          )
            issues.push(
              `the label "${(t2.textContent || "").trim()}" does not fit inside its node`,
            );
        }
      }
      // Rendered text is readable: the SVG's scale keeps 13 user units at 10px or more.
      const scale = s.width / box.width;
      if (13 * scale < 10) issues.push(`the diagram text is ${Math.round(13 * scale * 10) / 10}px`);
    }
  }

  // The quote band: smaller on a phone, and clear of the navigation.
  const band = document.querySelector(".band blockquote");
  if (band) {
    const fs = px(getComputedStyle(band).fontSize);
    if (vw < 768 && (fs > 44.1 || fs < 23.9)) issues.push(`the quote is ${fs}px on a phone`);
    if (vw < 768) {
      const lh = px(getComputedStyle(band).lineHeight) / fs;
      if (Math.abs(lh - 1.25) > 0.02)
        issues.push(`the quote line height is ${Math.round(lh * 100) / 100}`);
      const gap = rect(band).top - rect(document.querySelector(".band")).top;
      if (gap < 96)
        issues.push(`the quote starts only ${Math.round(gap)}px below the top of its band`);
    }
    const cap = document.querySelector(".band figcaption p");
    if (cap && px(getComputedStyle(cap).fontSize) < 14.5)
      issues.push("the quote caption is too small");
  }

  // Check marks are icons, not typed characters.
  if (/[✓✔]/.test(document.body.innerText)) issues.push("a typed check mark is on the page");
  const stamp = document.querySelector(".stamp-success");
  if (stamp) {
    const icon = stamp.querySelector("svg.tick");
    if (!icon) issues.push("the SIGNED BY TREASURY badge has no check icon");
    else {
      const fs = px(getComputedStyle(stamp).fontSize);
      if (Math.abs(rect(icon).height - fs * 1.1) > 1.5)
        issues.push("the badge check icon is not sized to its text");
      const mid = (a) => (a.top + a.bottom) / 2;
      if (Math.abs(mid(rect(icon)) - mid(rect(stamp.lastChild.parentElement))) > 8)
        issues.push("the badge check icon is not centred");
    }
  }

  // The marquee is gone; the FAQ link is not in the navigation.
  if (document.querySelector(".mq, .mq-track")) issues.push("the marquee is still on the page");
  const navLabels = [...document.querySelectorAll(".nav-links a")].map((a) => a.textContent.trim());
  if (navLabels.includes("FAQ")) issues.push("the navigation still has FAQ");
  if (navLabels.join("|") !== "How it works|Features|Tour|Docs")
    issues.push(`the navigation order is ${navLabels.join(", ")}`);
  if (!document.querySelector("#problem") || !document.querySelector("#solution"))
    issues.push("#problem or #solution is missing");
  return issues.slice(0, 10);
}

/** The drawer, with the menu button as a person uses it. Returns problems, as text. */
async function drawerChecks(page, origin, cfg, reduced) {
  const issues = [];
  const vw = page.viewportSize().width;
  const vh = page.viewportSize().height;
  const dialogOpen = () =>
    page.evaluate(() => document.querySelector("dialog.drawer")?.open === true);
  const button = page.getByRole("button", { name: "Open menu" });
  if (!(await button.isVisible())) return issues;
  const box = await button.boundingBox();
  if (!box || box.width < 43.5 || box.height < 43.5)
    issues.push(
      `the menu button is ${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)}px`,
    );
  if ((await button.getAttribute("aria-controls")) !== "mobile-menu")
    issues.push("the menu button has no aria-controls");
  if ((await button.getAttribute("aria-expanded")) !== "false")
    issues.push("aria-expanded is not false when closed");

  // Opening: the dialog is open and its slide-in has finished (a busy machine delays the start).
  const open = async () => {
    await button.click();
    await page
      .waitForFunction(() => document.querySelector("dialog.drawer")?.open === true, null, {
        timeout: 4000,
      })
      .catch(() => {});
    await page
      .evaluate(() =>
        Promise.all(
          document
            .querySelector(".drawer-panel")
            ?.getAnimations()
            .map((a) => a.finished) ?? [],
        ),
      )
      .catch(() => {});
    await page.waitForTimeout(reduced ? 40 : 120);
  };
  // Closing: the dialog has closed, then a moment for its close handler (focus, state, lock).
  const closed = async () => {
    await page
      .waitForFunction(() => document.querySelector("dialog.drawer")?.open !== true, null, {
        timeout: 4000,
      })
      .catch(() => {});
    await page.waitForTimeout(250);
  };
  await open();
  if (!(await dialogOpen())) return [...issues, "the menu button does not open the drawer"];
  if ((await button.getAttribute("aria-expanded")) !== "true")
    issues.push("aria-expanded is not true when open");
  const state = await page.evaluate(() => {
    const panel = document.querySelector(".drawer-panel");
    const r = panel.getBoundingClientRect();
    const links = [...document.querySelectorAll(".drawer nav a")].map((a) => ({
      text: a.textContent.trim(),
      h: a.getBoundingClientRect().height,
      w: a.getBoundingClientRect().width,
    }));
    const cta = document.querySelector(".drawer-foot .btn");
    const c = cta.getBoundingClientRect();
    return {
      right: r.right,
      left: r.left,
      top: r.top,
      bottom: r.bottom,
      links,
      cta: {
        text: cta.textContent.trim(),
        h: c.height,
        bottom: c.bottom,
        href: cta.getAttribute("href"),
      },
      locked: getComputedStyle(document.documentElement).overflow === "hidden",
      inDialog: document.querySelector("dialog.drawer").contains(document.activeElement),
      bg: getComputedStyle(panel).backgroundImage,
      blur: getComputedStyle(panel).backdropFilter || getComputedStyle(panel).webkitBackdropFilter,
      panelScrolls: panel.scrollHeight > panel.clientHeight + 1,
      scrollY: window.scrollY,
    };
  });
  if (state.left < -1 || state.right > vw + 1) issues.push("the drawer panel leaves the screen");
  if (Math.abs(state.top) > 1 || state.bottom < vh - 1)
    issues.push("the drawer panel does not fill the height");
  if (state.links.map((l) => l.text).join("|") !== "How it works|Features|Tour|Docs")
    issues.push(`the drawer links are ${state.links.map((l) => l.text).join(", ")}`);
  for (const l of state.links)
    if (l.h < 43.5 || l.w < 43.5)
      issues.push(`the drawer link "${l.text}" is ${Math.round(l.h)}px tall`);
  if (state.cta.text !== "Sign in" || state.cta.href !== "/app/sign-in")
    issues.push("the drawer button is not Sign in -> /app/sign-in");
  if (state.cta.h < 43.5) issues.push("the drawer Sign in button is too small");
  if (!state.panelScrolls && state.cta.bottom < vh * 0.7)
    issues.push("the drawer Sign in button is not near the bottom");
  if (!state.locked) issues.push("the page behind the drawer is not locked");
  if (!state.inDialog) issues.push("focus is not inside the drawer after it opens");
  if (!/rgba?\(/.test(state.bg) && state.bg === "none")
    issues.push("the drawer panel has no background");
  if (!/blur/.test(state.blur ?? "")) issues.push("the drawer panel has no backdrop blur");
  // The page behind does not scroll under the drawer.
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(150);
  if ((await page.evaluate(() => window.scrollY)) !== state.scrollY)
    issues.push("the page scrolls behind the open drawer");
  // Focus stays in the drawer however long a person tabs.
  for (let i = 0; i < 9; i += 1) {
    await page.keyboard.press("Tab");
    if (
      !(await page.evaluate(() =>
        document.querySelector("dialog.drawer").contains(document.activeElement),
      ))
    ) {
      issues.push("Tab moved focus out of the drawer");
      break;
    }
  }
  // Escape closes it and gives focus back to the menu button.
  await page.keyboard.press("Escape");
  await closed();
  if (await dialogOpen()) issues.push("Escape does not close the drawer");
  else {
    const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-controls"));
    if (back !== "mobile-menu")
      issues.push("focus does not return to the menu button after Escape");
    if ((await button.getAttribute("aria-expanded")) !== "false")
      issues.push("aria-expanded stays true after Escape");
    if (await page.evaluate(() => document.documentElement.classList.contains("nav-locked")))
      issues.push("the page stays locked after Escape");
  }
  // A tap on the backdrop closes it.
  await open();
  if (state.left > 8) {
    await page.mouse.click(Math.max(2, state.left / 2), Math.round(vh / 2));
    await closed();
    if (await dialogOpen()) issues.push("a tap on the backdrop does not close the drawer");
  } else issues.push("there is no backdrop strip to tap");
  // A tap on a link closes it and goes there.
  await open();
  await page.locator(".drawer nav a", { hasText: "Features" }).click();
  await closed();
  if (await dialogOpen()) issues.push("a tap on a drawer link does not close the drawer");
  if (!/#product$/.test(page.url())) issues.push("the Features link does not go to #product");
  // The close button.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await open();
  await page.getByRole("button", { name: "Close menu" }).click();
  await closed();
  if (await dialogOpen()) issues.push("the close button does not close the drawer");
  // Sign in from the drawer.
  await open();
  await page.locator(".drawer-foot .btn").click();
  await page.waitForLoadState("domcontentloaded");
  if (new URL(page.url()).pathname !== "/app/sign-in")
    issues.push("the drawer Sign in does not reach /app/sign-in");
  return issues;
}

async function landing(browser, origin) {
  const configs = sizeConfigs();
  const queue = [];
  for (const cfg of configs.filter((c) => onlyConfigs.length === 0 || onlyConfigs.includes(c.name)))
    for (const dark of [false, true]) queue.push({ cfg, dark });
  const shots = join(shotsRoot, "..", "landing");
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const run = async ({ cfg, dark }) => {
    const name = `${cfg.name}${dark ? "-dark" : ""}`;
    const ctx = await newContext(browser, cfg.options, { signedIn: false, dark });
    if (dark)
      await ctx.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          document.documentElement.dataset.theme = "dark";
        });
      });
    // Layout shift (CLS) from the first moment: nothing on the landing page may move once it is shown
    // (the balance counts up over a fixed-width amount, the entrances only transform).
    await ctx.addInitScript(() => {
      window.__cls = 0;
      window.__clsAt = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;
          window.__cls += e.value;
          if (e.value > 0.0005)
            window.__clsAt.push(
              e.sources
                .map(
                  (s) => `${s.node?.className?.baseVal ?? s.node?.className ?? s.node?.nodeName}`,
                )
                .join(" + "),
            );
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    const page = await ctx.newPage();
    const errors = [];
    await visit(page, origin, "/", errors);
    // Let the entrance animations finish and reveal every section.
    await page.waitForTimeout(3300);
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < total; y += 400) {
      await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: "instant" }), y);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    const vw = page.viewportSize().width;
    const issues = [
      ...(await page.evaluate(measure, { touch: cfg.touch, phone: cfg.phone })),
      ...(await page.evaluate(landingChecks, { vw })),
      ...errors.filter(
        (x) => x.startsWith("uncaught") || x.startsWith("could not load") || x.startsWith("CSP"),
      ),
    ];
    const shifts = await page.evaluate(() => ({ cls: window.__cls, at: window.__clsAt }));
    if (shifts.cls > 0.005)
      issues.push(
        `the page shifted (CLS ${Math.round(shifts.cls * 1000) / 1000}): ${shifts.at.slice(0, 3).join(" | ")}`,
      );
    // (WebKit's screenshot size limit makes a whole-page picture of a phone impossible; its layout checks
    // above are what counts.)
    if (!WEBKIT)
      try {
        await page.screenshot({
          path: join(shots, `${name}.jpg`),
          fullPage: true,
          type: "jpeg",
          quality: 55,
          timeout: 120000,
        });
      } catch (err) {
        issues.push(`screenshot failed: ${String(err.message).slice(0, 80)}`);
      }
    // The hero's "Open a treasury" goes to sign-up, and the navigation's Sign in to sign-in.
    const hero = await page.evaluate(() => ({
      open: document.querySelector("#top .cta .btn")?.getAttribute("href"),
      how: document.querySelector("#top .cta .hero-link")?.getAttribute("href"),
      signIn: document.querySelector(".nav .nav-open")?.getAttribute("href"),
      signInText: document.querySelector(".nav .nav-open")?.textContent.trim(),
    }));
    if (hero.open !== "/app/sign-up") issues.push(`'Open a treasury' goes to ${hero.open}`);
    if (hero.how !== "#how") issues.push(`'See how it works' goes to ${hero.how}`);
    if (hero.signIn !== "/app/sign-in" || hero.signInText !== "Sign in")
      issues.push("the navigation button is not Sign in -> /app/sign-in");
    // Drawer, then (on a fresh load) the reduced-motion drawer. Not in WebKit: Playwright's mobile WebKit
    // has no mouse wheel, and Safari's Tab key does not move between links, so these two checks can't
    // run there (the drawer is Chromium-checked, and nothing about it is part of the layout checks).
    if (!WEBKIT)
      try {
        for (const i of await drawerChecks(page, origin, cfg, false)) issues.push(i);
      } catch (err) {
        issues.push(`the drawer check stopped: ${String(err.message).slice(0, 140)}`);
      }
    await ctx.close();
    const rm = await browser.newContext({ ...cfg.options, reducedMotion: "reduce" });
    await rm.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue()
        : route.abort("blockedbyclient"),
    );
    const rpage = await rm.newPage();
    await visit(rpage, origin, "/", []);
    // The landing page's script loads after the load event; give it time, as a visitor would.
    await rpage.waitForTimeout(3300);
    if (!WEBKIT)
      try {
        for (const i of await drawerChecks(rpage, origin, cfg, true))
          issues.push(`(reduced motion) ${i}`);
      } catch (err) {
        issues.push(
          `(reduced motion) the drawer check stopped: ${String(err.message).slice(0, 140)}`,
        );
      }
    const animating = await rpage.evaluate(
      () => document.getAnimations().filter((a) => a.playState === "running").length,
    );
    if (animating > 0) issues.push(`(reduced motion) ${animating} animation(s) still run`);
    await rm.close();
    for (const i of new Set(issues)) fail("landing", `${name}`, i);
    console.log(
      `landing: ${name} ${issues.length === 0 ? "ok" : issues.length + " problem(s): " + [...new Set(issues)].join(" | ")}`,
    );
  };
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await run(job);
    }),
  );
  // Axe on the landing page, with the drawer open at phone size too.
  for (const [width, dark] of [
    [390, false],
    [1440, false],
    [390, true],
    [1440, true],
  ]) {
    const ctx = await newContext(
      browser,
      { viewport: { width, height: HEIGHT_FOR(width) } },
      { signedIn: false, dark },
    );
    const page = await ctx.newPage();
    await visit(page, origin, "/", []);
    await page.waitForTimeout(3300);
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < total; y += 400) {
      await page.evaluate((yy) => window.scrollTo({ top: yy, behavior: "instant" }), y);
      await page.waitForTimeout(40);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForTimeout(600);
    const scan = async (what) => {
      const r = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      for (const v of r.violations.filter((x) => x.impact === "serious" || x.impact === "critical"))
        fail(
          "axe",
          `landing @ ${width}${dark ? " dark" : ""} ${what}`,
          `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target}`,
        );
    };
    await scan("");
    if (width < 981) {
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.waitForTimeout(900);
      await scan("(drawer open)");
    }
    await ctx.close();
    console.log(`landing axe: ${width}px ${dark ? "dark" : "light"} done`);
  }
}

// ---------------------------------------------------------------------------------------------
// E2E_ORIGIN points the checks at a running dev server instead (fast CSS iteration only; the real
// run is against the production demo build).
const external = process.env.E2E_ORIGIN;
const { server, origin } = external
  ? { server: { close() {} }, origin: external }
  : await serve(0, { dir: join(web, "out-demo") });
// ENGINE=webkit runs the same checks in WebKit (Playwright's build of Safari's engine) instead of Chrome.
const browser =
  process.env.ENGINE === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const all = command === "all";
  if (all || command === "crawl") await crawl(browser, origin);
  if (all || command === "states") await states(browser, origin);
  if (all || command === "responsive") await responsive(browser, origin);
  if (all || command === "axe") await axe(browser, origin);
  if (command === "landing") await landing(browser, origin);
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
