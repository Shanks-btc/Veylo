// Phone checks for slice W7.1, on the demo build (out-demo), in WebKit (Playwright's build of Safari's
// engine) and in Chromium, each emulating an iPhone 15 and an iPhone SE. They exist because a real
// iPhone showed what Chromium did not: the "how it works" diagram cut off on the right, and a quote too
// large for the screen. Every check here fails the run:
//
//   - the page scrolls sideways;
//   - any text (HTML or SVG) reaches past the right or left edge of the screen;
//   - any text is cut off by an ancestor that hides its overflow (a drawing's own edge counts);
//   - the visible "how it works" drawing is not the vertical one, or a label is wider than its node;
//   - the quote is larger than 44px, or starts under the fixed navigation when scrolled to;
//   - the same checks again with the menu drawer open.
//
// usage: node scripts/webkit-check.mjs [--shots] [--self-test]   (WebKit installed with `playwright-core install webkit`)
// Exit code 0 = all passed, 1 = a check failed, 2 = WebKit is not installed (nothing was checked in it).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright-core";
import { serve } from "./serve.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const shotsDir = join(web, "..", "..", "design", "screenshots", "w7");
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const shots = process.argv.includes("--shots");
// --self-test puts the iPhone bug back (the wide drawing, 640px wide, inside a box that hides its
// overflow) and expects every run to notice it: proof that these checks can fail.
const selfTest = process.argv.includes("--self-test");
const BUG = `.tree .tree-wide{display:block!important;min-width:640px!important}
.tree .tree-tall{display:none!important}.tree{overflow-x:hidden!important}`;
const DEVICES = ["iPhone 15", "iPhone SE", "iPad Mini"];

const failures = [];
const results = [];

/** Runs in the page. Returns problems, as text. */
function clipChecks({ vw }) {
  const issues = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > vw + 1)
    issues.push(`the page scrolls sideways (${doc.scrollWidth}px wide on a ${vw}px screen)`);

  const cls = (el) => String(el.className?.baseVal ?? el.className ?? "").split(" ")[0];
  const name = (el) => `<${el.tagName.toLowerCase()}${cls(el) ? "." + cls(el) : ""}>`;
  // Backgrounds that bleed off the edge on purpose, and things that are not on the screen.
  const decorative =
    ".hero-globe, .hero-frame, .hero-photo, .hero-wash, .hero-vignette, .glare, .sr-only, .skip-link";
  const off = (el) => {
    if (el.closest(decorative)) return true;
    if (el.closest("dialog:not([open])")) return true;
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === "none" || cs.visibility === "hidden") return true;
    }
    return false;
  };
  const ellipsis = (el) => {
    for (let p = el, i = 0; p && i < 3; p = p.parentElement, i += 1)
      if (getComputedStyle(p).textOverflow === "ellipsis") return true;
    return false;
  };
  // The rectangle each ancestor lets through (an element that hides overflow, or an <svg>).
  const clips = (el) => {
    const out = [];
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (p.tagName.toLowerCase() === "svg" || /(hidden|clip)/.test(cs.overflowX)) out.push(p);
    }
    return out;
  };
  const textRects = (el) => {
    if (el instanceof SVGTextContentElement) return [el.getBoundingClientRect()];
    const rects = [];
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
    }
    return rects;
  };
  for (const el of document.querySelectorAll("body *")) {
    if (off(el) || ellipsis(el)) continue;
    const rects = textRects(el);
    if (rects.length === 0) continue;
    const sample = (el.textContent || "").trim().slice(0, 28);
    for (const r of rects) {
      if (r.right > vw + 1 || r.left < -1) {
        issues.push(
          `${name(el)} "${sample}" goes past the edge of the screen (${Math.round(r.left)} to ${Math.round(r.right)} of ${vw})`,
        );
        break;
      }
    }
    for (const clip of clips(el)) {
      const c = clip.getBoundingClientRect();
      if (rects.some((r) => r.right > c.right + 1 || r.left < c.left - 1)) {
        issues.push(`${name(el)} "${sample}" is cut off by ${name(clip)}`);
        break;
      }
    }
  }
  // An element that hides its overflow must not hide its own text.
  for (const el of document.querySelectorAll(
    "main :is(h1,h2,h3,p,li,span,a,dt,dd,strong,small):not(svg *)",
  )) {
    if (off(el) || ellipsis(el)) continue;
    const cs = getComputedStyle(el);
    if (/(hidden|clip)/.test(cs.overflowX + cs.overflowY) && el.scrollWidth > el.clientWidth + 1)
      issues.push(`${name(el)} clips its text`);
  }
  return [...new Set(issues)].slice(0, 12);
}

/** Runs in the page: the "how it works" drawing, the quote band. */
function pagePartChecks({ vw }) {
  const issues = [];
  const px = (v) => +String(v).replace("px", "");
  const svgs = [...document.querySelectorAll("#how .tree svg")].filter(
    (s) => getComputedStyle(s).display !== "none",
  );
  if (svgs.length !== 1) issues.push(`${svgs.length} how-it-works drawings are showing, not 1`);
  const svg = svgs[0];
  if (svg) {
    if (!svg.classList.contains("tree-tall"))
      issues.push("the horizontal drawing is showing on a phone");
    const box = svg.viewBox.baseVal;
    const s = svg.getBoundingClientRect();
    const scale = s.width / box.width;
    for (const el of svg.querySelectorAll("rect, text, circle")) {
      const b = el.getBBox();
      const label = (el.textContent || el.getAttribute("class") || "").trim().slice(0, 20);
      if (
        b.x < box.x - 0.5 ||
        b.x + b.width > box.x + box.width + 0.5 ||
        b.y < box.y - 0.5 ||
        b.y + b.height > box.y + box.height + 0.5
      )
        issues.push(`"${label}" is outside the drawing`);
      const r = el.getBoundingClientRect();
      if (r.left < -0.5 || r.right > vw + 0.5)
        issues.push(`"${label}" is cut off at the edge of the screen`);
    }
    for (const g of svg.querySelectorAll("g.node")) {
      const holders = [...g.querySelectorAll("rect")].map((r) => r.getBBox());
      for (const t of g.querySelectorAll("text")) {
        const tb = t.getBBox();
        if (g.querySelector("circle") || holders.length === 0) continue;
        const inside = holders.some(
          (h) =>
            tb.x >= h.x - 0.5 &&
            tb.x + tb.width <= h.x + h.width + 0.5 &&
            tb.y >= h.y - 0.5 &&
            tb.y + tb.height <= h.y + h.height + 0.5,
        );
        if (!inside) issues.push(`the label "${t.textContent.trim()}" is wider than its node`);
      }
    }
    if (13 * scale < 10) issues.push(`the drawing's text is only ${Math.round(13 * scale)}px`);
  }
  const quote = document.querySelector(".band blockquote");
  if (quote) {
    const fs = px(getComputedStyle(quote).fontSize);
    if (fs > 44.1) issues.push(`the quote is ${fs}px`);
    if (fs < 23.9) issues.push(`the quote is only ${fs}px`);
  }

  // The sample workspace: cards stacked, the payslip card a compact inset card (never a tall one,
  // which is what an iPad Mini showed), no big empty space inside any card, the subline in 2 lines
  // from 768px.
  const rect = (e) => e.getBoundingClientRect();
  const panel = document.querySelector("#top .hp");
  if (panel) {
    const card = panel.querySelector(".private-card");
    const section = panel.querySelector(".hp-contractor");
    if (card && section) {
      const h = rect(card).height;
      if (h > 185 && vw >= 360)
        issues.push(`the payslip card is ${Math.round(h)}px tall, over 185px`);
      if (h > 235) issues.push(`the payslip card is ${Math.round(h)}px tall on a phone`);
      if (rect(card).right > rect(section).right + 0.5)
        issues.push("the payslip card leaves its section");
      const label = section.querySelector(".hp-eye");
      if (!label || label.textContent !== "Contractor card")
        issues.push("the Contractor card label is missing");
    }
    if (vw < 1024) {
      const [t, r, c] = [".hp-treasury", ".hp-run", ".hp-contractor"].map((q) =>
        rect(panel.querySelector(q)),
      );
      if (!(t.bottom <= r.top + 1 && r.bottom <= c.top + 1))
        issues.push("the panel cards are not stacked");
    }
    for (const el of panel.querySelectorAll(".hp-card")) {
      const kids = [...el.children]
        .filter((k) => !k.classList.contains("glare"))
        .map(rect)
        .sort((a, b) => a.top - b.top);
      let covered = kids[0].bottom;
      for (const k of kids.slice(1)) {
        if (k.top - covered > 72) issues.push("a panel card has a large empty space inside it");
        covered = Math.max(covered, k.bottom);
      }
      if (rect(el).bottom - covered > 44) issues.push("a panel card has empty space at its bottom");
    }
    if (panel.querySelector(".hp-bars, .hp-chart, .hp-spark"))
      issues.push("the bar chart is still in the panel");
  }
  const lede = document.querySelector(".hero-lede");
  if (lede) {
    const lh = px(getComputedStyle(lede).lineHeight);
    const lines = Math.round(rect(lede).height / lh);
    if (vw >= 768 && lines !== 2) issues.push(`the subline is ${lines} lines at ${vw}px, not 2`);
  }
  return issues;
}

async function scrollThrough(page) {
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < total; y += 350) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(900);
}

async function run(engineName, launcher, options, origin, deviceName) {
  const tag = `${engineName} / ${deviceName}`;
  const issues = [];
  const browser = await launcher();
  try {
    const ctx = await browser.newContext({
      ...devices[deviceName],
      ...options,
      // The injected bug is a style tag, which the page's CSP refuses; only the self-test lifts that.
      ...(selfTest ? { bypassCSP: true } : {}),
    });
    await ctx.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue()
        : route.abort("blockedbyclient"),
    );
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(`uncaught: ${String(e.message).slice(0, 100)}`));
    await page.goto(`${origin}/`, { waitUntil: "load" });
    if (selfTest) await page.addStyleTag({ content: BUG });
    await page.waitForTimeout(3300);
    await scrollThrough(page);
    const vw = page.viewportSize().width;
    issues.push(...(await page.evaluate(clipChecks, { vw })));
    issues.push(...(await page.evaluate(pagePartChecks, { vw })));
    issues.push(...errors);

    // The quote, scrolled to the top of the screen, is below the fixed navigation.
    await page.evaluate(() =>
      document.querySelector(".band").scrollIntoView({ block: "start", behavior: "instant" }),
    );
    await page.waitForTimeout(400);
    const nav = await page.evaluate(() => {
      const bar = document.querySelector(".nav");
      const q = document.querySelector(".band blockquote").getBoundingClientRect();
      return { navBottom: bar.getBoundingClientRect().bottom, quoteTop: q.top };
    });
    if (nav.quoteTop < nav.navBottom + 8)
      issues.push(
        `the quote starts at ${Math.round(nav.quoteTop)}px, under the navigation (${Math.round(nav.navBottom)}px)`,
      );

    if (shots) {
      mkdirSync(shotsDir, { recursive: true });
      const slug = `${engineName}-${deviceName.toLowerCase().replaceAll(" ", "-")}`;
      await page.locator("#how .tree").scrollIntoViewIfNeeded();
      await page
        .locator("#how .tree")
        .screenshot({ path: join(shotsDir, `how-diagram-${slug}.png`) });
      await page.locator(".band").screenshot({ path: join(shotsDir, `quote-band-${slug}.png`) });
    }

    // The same, with the menu drawer open.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.waitForTimeout(900);
    const drawer = await page.evaluate(clipChecks, { vw });
    issues.push(...drawer.map((i) => `(menu open) ${i}`));
    await ctx.close();
  } finally {
    await browser.close();
  }
  for (const i of new Set(issues)) failures.push(`${tag}: ${i}`);
  results.push(`${tag}: ${issues.length === 0 ? "ok" : `${new Set(issues).size} problem(s)`}`);
  console.log(`${tag}: ${issues.length === 0 ? "ok" : [...new Set(issues)].join(" | ")}`);
}

const { server, origin } = await serve(0, { dir: join(web, "out-demo") });
let webkitMissing = false;
try {
  for (const d of DEVICES) {
    await run(
      "chromium",
      () => chromium.launch({ executablePath: CHROME, headless: true }),
      {},
      origin,
      d,
    );
    try {
      await run("webkit", () => webkit.launch({ headless: true }), {}, origin, d);
    } catch (err) {
      if (
        /Executable doesn't exist|playwright install|browserType\.launch/.test(String(err.message))
      ) {
        webkitMissing = true;
        console.log(
          `webkit / ${d}: NOT RUN, WebKit is not installed (${String(err.message).split("\n")[0].slice(0, 90)})`,
        );
      } else throw err;
    }
  }
} finally {
  server.close();
}
console.log(
  `\n${results.length} run(s): ${results.filter((r) => r.endsWith("ok")).length} ok, ${failures.length} problem(s)`,
);
if (selfTest) {
  const quiet = results.filter((r) => r.endsWith("ok"));
  console.log(
    quiet.length === 0
      ? "self-test: every run noticed the injected bug"
      : `self-test FAILED: ${quiet.join("; ")} did not notice the injected bug`,
  );
  process.exit(quiet.length === 0 && !webkitMissing ? 0 : 1);
}
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
process.exit(webkitMissing ? 2 : 0);
