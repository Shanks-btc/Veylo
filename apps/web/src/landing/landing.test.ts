// The landing page (slices W7, W7.1 and W7.2): the navigation, the hero and its sample workspace, the
// trust line, the problem and solution sections, how it works, the timeline, and the things that must
// be gone (the marquee, the pinned story, the chips and the FAQ link in the nav). Rendered on the
// server, as the static export does it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { color } from "../design/tokens";
import { PROOF_CASES } from "../proof/cases";
import { ENABLED_WALLETS } from "../wallet/registry";
import { centsAt, formatCents } from "./card-fx";
import {
  MAINNET_TX_COUNT,
  Preview,
  SAMPLE_RUN,
  SAMPLE_RUN_TOTAL,
  SAMPLE_TREASURY,
  TrustLine,
} from "./hero-extras";
import { LandingNav, NAV_LINKS, SIGN_IN } from "./nav";
import { Problem, SOLUTION_CONDITION, Solution } from "./pitch";
import {
  Closing,
  Faq,
  Features,
  Footer,
  HOW_STEPS,
  Hero,
  How,
  QuoteBand,
  StorySection,
  Who,
} from "./sections";

const src = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(join(src, file), "utf8");
const css = read("styles/landing.css");
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
const html = (component: Parameters<typeof createElement>[0]) =>
  renderToStaticMarkup(createElement(component));
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
/** Every CSS rule (innermost block) with its selector list. */
const rules = (source: string) =>
  [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: (m[1] ?? "").split(",").map((s) => s.trim()),
    body: m[2] ?? "",
  }));
const ruleBody = (selector: string) =>
  rules(css)
    .filter((r) => r.selectors.includes(selector))
    .map((r) => r.body)
    .join("\n");
/** Whole cents from "248,420.50". */
const cents = (amount: string) => BigInt(amount.replace(/[$,.]/g, ""));

describe("the navigation", () => {
  it("is How it works, Features, Tour, Docs, then the Sign in button", () => {
    expect(NAV_LINKS.map((l) => l.label)).toEqual(["How it works", "Features", "Tour", "Docs"]);
    expect(NAV_LINKS.map((l) => l.href)).toEqual(["#how", "#product", "#story", "/docs"]);
    expect(SIGN_IN).toEqual({ href: "/app/sign-in", label: "Sign in" });
  });

  it("the drawer lists the same links in the same order", () => {
    const nav = html(LandingNav);
    const drawer = nav.slice(nav.indexOf('aria-label="Mobile"'));
    const labels = [...drawer.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(NAV_LINKS.map((l) => l.label));
  });

  it("has no FAQ, Problem or Solution link, and no 'Open app' button, in either navigation", () => {
    const nav = html(LandingNav);
    const mainNav = nav.slice(nav.indexOf('aria-label="Main"'), nav.indexOf("</nav>"));
    for (const markup of [mainNav, nav]) {
      expect(markup).not.toMatch(/>FAQ</);
      expect(markup).not.toMatch(/href="#(faq|problem|solution)"/);
    }
    expect(nav).not.toContain("Open app");
    expect(read("landing/nav.tsx")).not.toContain("Open app");
    // Sign in appears in the desktop bar and at the bottom of the drawer, both to the sign-in page.
    expect(nav.match(/href="\/app\/sign-in"/g)).toHaveLength(2);
    expect(text(nav).match(/Sign in/g)).toHaveLength(2);
  });

  it("keeps the FAQ section on the page and its link in the footer", () => {
    expect(html(Faq)).toContain('id="faq"');
    expect(html(Footer)).toContain('href="#faq"');
  });

  it("the drawer is a labelled modal dialog the menu button controls", () => {
    const nav = html(LandingNav);
    expect(nav).toContain('id="mobile-menu"');
    expect(nav).toContain('aria-controls="mobile-menu"');
    expect(nav).toContain('aria-expanded="false"');
    expect(nav).toContain('aria-haspopup="dialog"');
    expect(nav).toContain('aria-label="Close menu"');
  });

  it("the drawer's behaviour is in the component: modal, scroll lock, Escape, backdrop tap, link tap, focus back", () => {
    const code = read("landing/nav.tsx");
    for (const needed of [
      "showModal()",
      'LOCK_CLASS = "nav-locked"',
      "onCancel",
      "onKeyDown",
      "e.shiftKey",
      'command: "show-modal"',
      "e.target === e.currentTarget",
      "onClick={requestClose}",
      "opener.current?.focus()",
      "prefersReducedMotion()",
    ])
      expect(code, needed).toContain(needed);
  });

  it("the drawer is dark, glassy, locks the page and has big touch targets", () => {
    expect(ruleBody(".drawer-panel")).toContain("backdrop-filter: blur");
    expect(ruleBody(".drawer-panel")).toContain("var(--c-dark1)");
    expect(ruleBody(".drawer nav a")).toMatch(/min-height:\s*64px/);
    expect(ruleBody(".drawer-head button")).toMatch(/min-height:\s*44px/);
    expect(ruleBody(".drawer-foot .btn")).toMatch(/min-height:\s*56px/);
    expect(ruleBody(":root.nav-locked")).toContain("overflow: hidden");
    // Never amber: that colour is for things that are private.
    const drawerCss = css.slice(css.indexOf(".drawer {"), css.indexOf("/* 2. Hero */"));
    expect(drawerCss).not.toMatch(/--c-private/);
  });

  it("uses the same length for the close animation in script and in CSS", () => {
    const ms = Number(/CLOSE_MS = (\d+)/.exec(read("landing/nav.tsx"))?.[1]);
    expect(ms).toBeGreaterThan(0);
    expect(ruleBody(".drawer.is-closing .drawer-panel")).toContain(`drawer-out ${ms}ms`);
  });
});

describe("the hero", () => {
  const hero = html(Hero);

  it("has the founder's headline and the two-line subline under it", () => {
    expect(text(hero)).toContain("Pay your team anywhere. Keep payroll private.");
    expect(text(hero)).toContain(
      "Companies pay global teams privately in USDC on NEAR. Gasless for your team.",
    );
    // Two lines on a desktop: a break after the first sentence, which goes away on a phone.
    expect(hero).toMatch(
      /Companies pay global teams privately in USDC on NEAR\. <br class="hero-br"\/>Gasless for your team\./,
    );
    expect(css).toMatch(
      /@media \(max-width: 767px\) \{[^}]*\.hero \.hero-lede \{[^}]*\}\s*\.hero-br \{\s*display: none/,
    );
    // The earlier sublines are gone.
    expect(text(hero)).not.toContain("Private salaries in USDC on NEAR");
    expect(text(hero)).not.toContain("Only you move the money");
    expect(text(hero)).not.toContain("Salaries are paid through NEAR Confidential Intents");
  });

  it("has one solid action, 'Open a treasury', to the sign-up page", () => {
    expect(hero.match(/class="btn /g)).toHaveLength(1);
    expect(hero).toMatch(/<a class="btn btn-light" href="\/app\/sign-up">Open a treasury<\/a>/);
  });

  it("has a quiet text link, 'See how it works', down to #how, with no button styling", () => {
    expect(hero).toMatch(/<a class="hero-link" href="#how">See how it works</);
    const body = ruleBody(".hero-link");
    expect(body).not.toMatch(/border(?!-radius)[^:]*:\s*[^;]*\dpx/);
    expect(body).not.toMatch(/background/);
    expect(body).not.toMatch(/border-radius/);
  });

  it("has no route chips and no proof row any more", () => {
    for (const gone of [
      "NEAR · PRIVATE",
      "NEAR · DIRECT",
      "Running on NEAR mainnet",
      "Payout routes",
      "chips",
      "proof-row",
      "pchip",
    ])
      expect(hero, gone).not.toContain(gone);
    expect(css).not.toMatch(/\.chips?\b|\.pchip|\.proof-|\.chip-private/);
  });

  it("no longer carries the privacy line (it stays in the solution section and the FAQ)", () => {
    expect(text(hero)).not.toContain("Private means no public source we checked");
    expect(hero).not.toContain("hero-cond");
    expect(text(html(Faq))).toContain(
      "No public source we checked links a confidential payout to your company, provided the payout address has never received a public payment from you.",
    );
  });

  it("ends with a plain trust line under the sample workspace, in that order", () => {
    const at = (needle: string) => hero.indexOf(needle);
    expect(at('class="hp"')).toBeGreaterThan(at('class="cta"'));
    expect(at('class="trust-line"')).toBeGreaterThan(at('id="hp-caption"'));
    expect(hero.lastIndexOf("</section>")).toBeGreaterThan(at('class="trust-line"'));
  });

  it("the trust line is plain text; only the transaction count is a link, to /proof", () => {
    const markup = html(TrustLine);
    expect(text(markup)).toBe(
      `Live on NEAR mainnet · ${MAINNET_TX_COUNT} test transactions verified · ${ENABLED_WALLETS.length} wallets · Gasless for payees`,
    );
    expect(markup.match(/<a /g)).toHaveLength(1);
    expect(markup).toMatch(
      new RegExp(`<a href="/proof">${MAINNET_TX_COUNT} test transactions verified</a>`),
    );
    expect(markup).not.toMatch(/<(button|ul|li)|class="(?!trust-line")/);
    // No border, fill, radius or hover on the line itself.
    const body = ruleBody(".hero .trust-line");
    expect(body).not.toMatch(/border|background|padding|radius|cursor/);
    expect(cssNoComments).not.toMatch(/\.trust-line:hover/);
    // The link is underlined.
    expect(ruleBody(".trust-line a")).toContain("text-decoration: underline");
  });

  it("computes its numbers from the code and never types them in", () => {
    expect(MAINNET_TX_COUNT).toBe(PROOF_CASES.flatMap((c) => c.nearTxs).length);
    expect(MAINNET_TX_COUNT).toBeGreaterThan(0);
    expect(ENABLED_WALLETS.length).toBeGreaterThan(0);
    const code = read("landing/hero-extras.tsx");
    expect(code).toContain("PROOF_CASES.reduce(");
    expect(code).toContain("ENABLED_WALLETS.length");
    expect(code).not.toMatch(/["'`]\s*\d+ (mainnet|test transactions|NEAR wallets|wallets)/);
  });

  it("says nothing about customers, usage, yield or compliance", () => {
    const words = text(hero) + text(html(Preview));
    for (const banned of [
      /trusted by/i,
      /customers?/i,
      /\bAPY\b|\byield\b|\binterest\b/i,
      /\bvisa\b|debit card|off-?ramp/i,
      /complian/i,
      /countries/i,
      /\d+\+? (teams|companies|users)/i,
      /logo/i,
    ])
      expect(words, String(banned)).not.toMatch(banned);
  });
});

describe("the sample workspace panel", () => {
  const markup = html(Preview);
  const words = text(markup);

  it("is one panel labelled 'Sample workspace' underneath, holding three cards", () => {
    expect(markup.match(/class="hp-frame"/g)).toHaveLength(1);
    expect(markup.match(/class="hp-card /g)).toHaveLength(3);
    expect(markup.indexOf('id="hp-caption"')).toBeGreaterThan(markup.lastIndexOf("</article>"));
    expect(words.endsWith("Sample workspace")).toBe(true);
    expect(ruleBody(".hp-caption")).toContain("font-size: 13px");
    // The privacy card is gone.
    expect(words).not.toContain("Privacy proof");
    expect(words).not.toContain("See what the public sees");
  });

  it("has the treasury card, and nothing else in it: label, balance with its badge, three tiles, one footer line", () => {
    const treasury = markup.slice(
      markup.indexOf('aria-label="Treasury"'),
      markup.indexOf('aria-label="Pay run"'),
    );
    const parts = [
      "Treasury balance",
      "$248,420.50",
      "USDC on NEAR",
      "Available $235,670.50",
      "Reserved for next pay run $12,750.00",
      "Paid this month $31,984.00",
      "Gasless for everyone · Only you can approve payouts",
    ];
    for (const part of parts) expect(text(treasury), part).toContain(part);
    // The balance and its badge are on one row.
    expect(treasury).toMatch(
      /class="hp-balance"><span class="hp-amount"[\s\S]*?<span class="hp-badge">USDC on NEAR<\/span><\/div>/,
    );
    // In this order, and nothing between them: the label, the balance row, the tiles, the footer.
    const order = ["hp-eye", "hp-balance", "hp-tiles", "hp-foot"].map((c) =>
      treasury.indexOf(`class="${c}`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(treasury.match(/class="hp-tile"/g)).toHaveLength(3);
    expect(treasury.match(/<p class="hp-foot">/g)).toHaveLength(1);
    // The paid-out bar chart is gone: markup, styles, animation.
    expect(words).not.toContain("Paid out");
    for (const gone of ["hp-spark", "hp-chart", "hp-bars", "hp-months", "<li>Jun", "<li>Nov"])
      expect(markup, gone).not.toContain(gone);
    expect(css).not.toMatch(/hp-bars|hp-spark|hp-chart|hp-months|lp-grow|sparkline/);
    expect(markup).toMatch(/class="hp-shield-success"/);
  });

  it("the treasury card fits its content: the footer line sits at the bottom, no chart fills the card", () => {
    expect(ruleBody(".hp-foot")).toContain("margin-top: auto");
    expect(ruleBody(".hp-treasury")).not.toMatch(/min-height|height:/);
  });

  it("the treasury adds up in whole cents (available + reserved = balance)", () => {
    expect(cents(SAMPLE_TREASURY.available) + cents(SAMPLE_TREASURY.reserved)).toBe(
      cents(SAMPLE_TREASURY.balance),
    );
    // The count-up's target is that balance in cents.
    expect(markup).toContain(`data-count-cents="${cents(SAMPLE_TREASURY.balance)}"`);
  });

  it("has the pay run card: five paid, three private, two direct, checked in the browser", () => {
    expect(words).toContain("Pay run · November");
    expect(words).toContain("5 people paid · $16,500.00");
    expect(words).toContain("3 private · 2 direct · approved in your wallet");
    expect(words).toContain("Every address and amount checked in your browser");
    expect(SAMPLE_RUN).toHaveLength(5);
    expect(SAMPLE_RUN.filter((r) => r.route === "private")).toHaveLength(3);
    expect(SAMPLE_RUN.reduce((n, r) => n + cents(r.amount), 0n)).toBe(cents(SAMPLE_RUN_TOTAL));
    expect(markup).toMatch(/class="hp-dot-success"/);
  });

  it("has a labelled 'Contractor card' (an article, so the page's section padding never applies), like 'Pay run · November', with the payslip card inset in it", () => {
    expect(markup).toContain(
      '<article class="hp-card hp-contractor card-fx" aria-label="Contractor card">',
    );
    expect(markup).not.toMatch(/<section/);
    const section = markup.slice(markup.indexOf('aria-label="Contractor card"'));
    expect(section).toMatch(
      /^aria-label="Contractor card"><span class="hp-eye">Contractor card<\/span><article class="private-card"/,
    );
    // The same small mono label as the pay run's.
    expect(markup).toContain('<span class="hp-eye">Pay run · November</span>');
    expect(ruleBody(".hp-eye")).toContain("font-family: var(--font-mono)");
    expect(ruleBody(".hp-eye")).toContain("text-transform: uppercase");
  });

  it("the payslip card keeps its content, and is a compact inset card, not a tall one", () => {
    expect(words).toContain("veylo");
    expect(words).toContain("Private");
    expect(words).toContain("Ada L.");
    expect(words).toContain("USDC on NEAR · ada-l.near");
    expect(words).toContain("Nov salary $4,200.00");
    expect(words).toContain("Paid · not publicly linked");
    expect(words).toContain(
      "Contractors see payslips and their private balance in their own portal.",
    );
    // The salary on the card is Ada's, from the same sample run.
    expect(cents("4,200.00")).toBe(cents(SAMPLE_RUN[0].amount));
    // Its height comes from its content (20px padding, no empty middle), never from a fixed ratio.
    const card = ruleBody(".private-card");
    expect(card).toContain("padding: 20px");
    expect(card).toContain("border-radius: 18px");
    expect(card).not.toMatch(/aspect-ratio|min-height|justify-content:\s*space-between/);
    expect(css).toMatch(/@media \(max-width: 1023px\) \{\s*\.private-card \{\s*max-width: 440px/);
    expect(ruleBody(".hp-note")).toContain("font-size: 13px");
  });

  it("is a 7/12 and 5/12 grid from 1024px, stacked with the treasury first below that", () => {
    expect(markup.indexOf("hp-treasury")).toBeLessThan(markup.indexOf("hp-run"));
    expect(markup.indexOf("hp-run")).toBeLessThan(markup.indexOf("hp-contractor"));
    expect(ruleBody(".hp-grid")).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toMatch(
      /@media \(min-width: 1024px\) \{\s*\.hp-grid \{[^}]*minmax\(0, 7fr\) minmax\(0, 5fr\)/,
    );
    expect(css).toMatch(/\.hp-treasury \{\s*grid-row: 1 \/ span 2/);
  });

  it("is dark glass with a thin border, a 28px radius, 16px padding and an indigo glow", () => {
    const frame = ruleBody(".hp-frame");
    expect(frame).toContain("padding: 16px");
    expect(frame).toContain("border-radius: var(--r-card-md)");
    expect(frame).toMatch(/border: 1px solid color-mix\(in srgb, var\(--c-white\) 8%/);
    expect(ruleBody(".hp-frame::before")).toContain("var(--c-accent)");
  });

  it("stacks the stat tiles to one column when the card is narrow, and uses tabular numbers", () => {
    expect(css).toMatch(
      /@container \(max-width: 400px\) \{\s*\.hp-tiles \{\s*grid-template-columns: minmax\(0, 1fr\)/,
    );
    expect(ruleBody(".hp-amount")).toContain("font-variant-numeric: tabular-nums");
    expect(ruleBody(".hp-amount")).toContain("clamp(36px, 4vw, 52px)");
    expect(ruleBody(".hp-eye")).toContain("letter-spacing: 0.12em");
  });

  it("is HTML and CSS only: no images, no canvas, no inline style", () => {
    expect(markup).not.toMatch(/<img|<picture|<video|<canvas|\sstyle=/);
  });

  it("nothing in it is clickable, so nothing in it is a link, a button or looks like one", () => {
    expect(markup).not.toMatch(/<(a|button|input|select)\b|onclick|role="button"/i);
    for (const klass of ["hp-badge", "private-badge"]) {
      const body = ruleBody(`.${klass}`);
      expect(body, klass).not.toMatch(/cursor/);
      expect(cssNoComments, klass).not.toMatch(new RegExp(`\\.${klass}:hover`));
    }
    // The badge next to the balance has no outline at all.
    expect(ruleBody(".hp-badge")).not.toMatch(/border(?!-radius)/);
  });

  it("amber is used only on the private card and its badge; green only on what went through", () => {
    for (const r of rules(css)) {
      if (/--c-private|--private-/.test(r.body)) {
        for (const s of r.selectors) {
          if (/\.(hp|pc|private)/.test(s) || /^\.private/.test(s))
            expect(s, r.body).toMatch(/priv/i);
        }
      }
      if (/--c-success|--success-/.test(r.body) && r.selectors.some((s) => /\.hp-/.test(s))) {
        for (const s of r.selectors) expect(s).toMatch(/success/);
      }
    }
    // The card's own mark leaves out the logo's amber veil: amber is the PRIVATE badge and the edge.
    expect(markup).not.toContain("logo-veil");
  });

  it("the tilt comes from the one card island, and the card sheen stops for reduced motion", () => {
    // The three cards tilt; the payslip card inside the third one only has its sheen.
    expect(markup.match(/card-fx/g)).toHaveLength(3);
    expect(markup.match(/class="glare"/g)).toHaveLength(3);
    expect(ruleBody(".private-card:hover::after")).toContain("translateX(115%)");
    const base = read("styles/base.css");
    expect(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(base)?.[1]).toMatch(
      /transition:\s*none !important/,
    );
  });
});

describe("the balance counts up once, in whole cents", () => {
  it("formats cents as dollars with thousands separators and two decimals", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(24842050)).toBe("$248,420.50");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });

  it("starts at zero, ends on the exact balance and never goes backwards", () => {
    const target = 24842050;
    expect(centsAt(target, 0, 600)).toBe(0);
    expect(centsAt(target, 600, 600)).toBe(target);
    expect(centsAt(target, 900, 600)).toBe(target);
    let last = 0;
    for (let t = 0; t <= 600; t += 25) {
      const now = centsAt(target, t, 600);
      expect(now).toBeGreaterThanOrEqual(last);
      expect(Number.isInteger(now)).toBe(true);
      last = now;
    }
  });

  it("takes 600 ms, only under motion, and leaves the final text for reduced motion", () => {
    const code = read("landing/card-fx.tsx");
    expect(code).toContain("const COUNT_MS = 600;");
    expect(code).toMatch(/if \(prefersReducedMotion\(\)\) return;/);
    // The count-up is inside the effect that returns early under reduced motion.
    expect(code.indexOf("prefersReducedMotion()")).toBeLessThan(code.indexOf("countUp(el)"));
    expect(code).not.toMatch(/toFixed|parseFloat|Number\(/);
  });

  it("never changes the layout while it counts: the final amount keeps its place and the figure is drawn over it", () => {
    // The first live Lighthouse run of W7.1 measured CLS 0.054: on a phone the balance's width changed
    // as it counted, and the badge and the stat tiles beside and under it moved, twice.
    const markup = html(Preview);
    expect(markup).toMatch(
      /class="hp-amount"[^>]*><span class="hp-final">\$248,420\.50<\/span><span class="hp-live" aria-hidden="true"><\/span>/,
    );
    const live = ruleBody(".hp-live");
    expect(live).toContain("position: absolute");
    expect(ruleBody(".hp-amount.counting .hp-final")).toContain("visibility: hidden");
    const code = read("landing/card-fx.tsx");
    expect(code).toContain('querySelector<HTMLElement>(".hp-live")');
    // The island writes only into the overlay, never into the element that holds the space.
    expect(code).not.toMatch(/el\.textContent\s*=/);
  });
});

describe("the problem and the solution", () => {
  it("the problem section has its id, eyebrow, heading and three cards (the earlier design)", () => {
    const markup = html(Problem);
    expect(markup).toContain('id="problem"');
    const words = text(markup);
    expect(words).toContain("The problem");
    expect(words).toContain("Paying your team onchain puts payroll on a public explorer.");
    for (const h of [
      "Everyone sees who you pay.",
      "Everyone sees what they earn.",
      "Paying abroad is slow and costly.",
    ])
      expect(words, h).toContain(h);
    expect(words).toContain(
      "Every salary payment links your company wallet to each person you pay, visible to anyone, forever.",
    );
    expect(words).toContain(
      "Competitors, recruiters and strangers can read salaries and totals from a block explorer.",
    );
    expect(words).toContain(
      "Bank wires take days and charge fees on both ends; many contractors wait weeks.",
    );
    expect(markup.match(/solid-icon solid-indigo/g)).toHaveLength(3);
    // The heading, then the three cards in a row: the same shape as every other section.
    expect(markup).toMatch(
      /<div class="wrap"><span class="eye">The problem<\/span><h2 id="pb-h">[^<]*<\/h2><div class="pitch">/,
    );
    expect(markup.match(/class="card card-fx"/g)).toHaveLength(3);
  });

  it("the solution section has its id, heading, paragraph, three points and the condition, verbatim", () => {
    const markup = html(Solution);
    expect(markup).toContain('id="solution"');
    const words = text(markup);
    expect(words).toContain("The solution");
    expect(words).toContain("One private treasury that pays your whole team.");
    expect(words).toContain(
      "Veylo pays salaries from a NEAR Intents treasury in USDC on NEAR. Private payouts go through NEAR Confidential Intents, so they aren't publicly linked to your company.",
    );
    for (const h of ["Private by default.", "Gasless and fast.", "Only you can move money."])
      expect(words, h).toContain(h);
    expect(words).toContain("Confidential payouts.");
    expect(words).toContain("Your team gets USDC on NEAR with no gas to pay.");
    expect(words).toContain(
      "You approve every payout in your own wallet; your browser checks every address and amount before you sign. Veylo's server can't move funds.",
    );
    expect(SOLUTION_CONDITION).toBe(
      "No public source we checked links a confidential payout to your company, provided the payout address has never received a public payment from you.",
    );
    expect(words).toContain(SOLUTION_CONDITION);
    // Gradient icon tiles, as before; amber only on "Private by default."
    expect(markup.match(/solid-icon/g)).toHaveLength(3);
    expect(markup.match(/solid-private/g)).toHaveLength(1);
    expect(markup).toMatch(/solid-icon solid-private[\s\S]*?Private by default\./);
  });

  it("the W7.1 dark band, sticky two-column layout and 'Veylo fixes this' connector are gone", () => {
    for (const file of ["landing/pitch.tsx", "app/page.tsx"]) {
      const code = read(file);
      expect(code, file).not.toMatch(
        /Connector|Veylo fixes this|pitch-dark|pitch-light|pitch-lead|SoftIcon/,
      );
    }
    expect(css).not.toMatch(
      /\.pitch-(sec|dark|light|lead|layout|right|cards|card|text)\b|\.fixes|\.soft-icon|\.soft-(neutral|indigo|private|mint)/,
    );
    expect(text(html(Problem) + html(Solution))).not.toContain("Veylo fixes this");
    // Light, like the page: no band of its own on either section.
    for (const id of ["#problem", "#solution"])
      expect(ruleBody(id)).not.toMatch(/background|color:/);
  });

  it("the order on the page: hero, problem, solution, how it works, features, tour, who, quote, FAQ, closing", () => {
    const page = read("app/page.tsx");
    const order = [
      "<Hero />",
      "<Problem />",
      "<Solution />",
      "<How />",
      "<Features />",
      "<StorySection />",
      "<Who />",
      "<QuoteBand />",
      "<Faq />",
      "<Closing />",
    ];
    const at = order.map((o) => page.indexOf(o));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(NAV_LINKS.map((l) => l.href)).not.toContain("#problem");
    expect(NAV_LINKS.map((l) => l.href)).not.toContain("#solution");
  });

  it("their headings are the relaxed size: clamp(32px, 4vw, 48px), 1.15, -0.01em", () => {
    const h = ruleBody("#problem h2") + ruleBody("#solution h2");
    expect(h).toContain("clamp(32px, 4vw, 48px)");
    expect(h).toContain("line-height: 1.15");
    expect(h).toContain("letter-spacing: -0.01em");
    expect(ruleBody("#problem h2")).toBe(ruleBody("#solution h2"));
  });

  it("three cards in a row, one column below 980px, with the earlier spacing", () => {
    const pitch = ruleBody(".pitch");
    expect(pitch).toContain("repeat(3, minmax(0, 1fr))");
    expect(pitch).toContain("gap: 20px");
    expect(css).toMatch(/\.who,\s*\.pitch \{\s*grid-template-columns: 1fr/);
    expect(ruleBody("#problem")).toContain("padding-block: 110px 40px");
    expect(ruleBody("#solution")).toContain("padding-block: 40px 110px");
    expect(css).toMatch(/\.pitch > \.rev:nth-child\(2\)/);
  });

  it("is plain markup with no inline style, and nothing is pinned", () => {
    expect(read("landing/pitch.tsx")).not.toMatch(/\bstyle=\{|\bstyle="/);
    expect(css).not.toMatch(/position:\s*sticky/);
  });
});

describe("every section shares one container and one left edge", () => {
  const sections = [
    "Problem",
    "Solution",
    "How",
    "Features",
    "StorySection",
    "Who",
    "Faq",
    "Closing",
  ];
  const rendered: Record<string, string> = {
    Problem: html(Problem),
    Solution: html(Solution),
    How: html(How),
    Features: html(Features),
    StorySection: html(StorySection),
    Who: html(Who),
    Faq: html(Faq),
    Closing: html(Closing),
  };

  it("each section is one .wrap holding its eyebrow, heading, intro and cards", () => {
    for (const name of sections) {
      const markup = rendered[name] ?? "";
      expect(markup.match(/<section\b/g), name).toHaveLength(1);
      // The section's content sits in one container, directly inside the section.
      expect(markup, name).toMatch(/^<section [^>]*><div class="wrap">/);
    }
  });

  it("the container has one width and one gutter, set in one place", () => {
    const base = read("styles/base.css");
    expect(base).toMatch(/\.wrap \{[^}]*max-width: 1240px/);
    expect(base).toMatch(/\.wrap \{[^}]*margin: 0 auto/);
    // No section narrows or shifts its own container: a .wrap is never restyled sideways on the
    // landing page (the footer's .wrap only has its own top and bottom space).
    for (const r of rules(css).filter((rule) => rule.selectors.some((sel) => /\.wrap$/.test(sel))))
      expect(r.body, r.selectors.join(",")).not.toMatch(
        /width|margin|padding-(left|right|inline)|padding:|transform|translate|position/,
      );
    // No section pushes its heading, intro or cards sideways with its own margin or padding.
    for (const id of [
      "#problem",
      "#solution",
      "#how",
      "#product",
      "#story",
      "#who",
      "#faq",
      "#start",
    ])
      expect(ruleBody(id), id).not.toMatch(
        /(margin|padding)-(left|right)|padding-inline|margin-inline|padding:\s*\d+px \d+px|margin:\s*0 \d+px/,
      );
  });
});

describe("how it works", () => {
  const markup = html(How);
  const words = text(markup);

  it("has four numbered steps, in the founder's words", () => {
    expect(HOW_STEPS.map((s) => s.h)).toEqual([
      "Add your team",
      "Fund in USDC",
      "Review and approve",
      "Paid, privately",
    ]);
    expect(markup.match(/class="rev how-step"/g)).toHaveLength(4);
    expect(markup.match(/class="how-num"/g)).toHaveLength(4);
    expect(words).toContain("Names, salaries in USD and payout addresses.");
    expect(words).toContain("Send USDC on NEAR to your treasury.");
    expect(words).toContain(
      "Your browser checks every address and amount; you approve in your wallet.",
    );
    expect(words).toContain("USDC arrives gasless; private payouts aren't publicly linked to you.");
  });

  it("is four across on a desktop, two by two on a tablet and one after another on a phone", () => {
    expect(ruleBody(".how-steps")).toContain("repeat(4, minmax(0, 1fr))");
    expect(css).toMatch(
      /@media \(max-width: 1023px\) \{\s*\.how-steps \{\s*grid-template-columns: repeat\(2/,
    );
    expect(css).toMatch(
      /@media \(max-width: 599px\) \{\s*\.how-steps \{\s*grid-template-columns: minmax\(0, 1fr\)/,
    );
  });

  it("keeps the trust diagram under the steps, drawn across and drawn top to bottom", () => {
    expect(markup.indexOf("how-steps")).toBeLessThan(markup.indexOf('class="tree'));
    expect(markup.match(/<svg /g)).toHaveLength(2);
    expect(markup).toContain('class="tree-wide"');
    expect(markup).toContain('class="tree-tall"');
    for (const node of ["Treasury", "Pay run", "Browser checks", "Private", "Direct"])
      expect(words, node).toContain(node);
    // The top-to-bottom drawing has every node of the other one.
    const tall = markup.slice(markup.indexOf('class="tree-tall"'));
    for (const label of [
      "Treasury",
      "Pay run",
      "payee list",
      "quotes",
      "Browser checks",
      "Private",
      "Direct",
    ])
      expect(tall, label).toContain(label);
    expect(css).toMatch(/@media \(max-width: 899px\) \{\s*\.tree \.tree-wide \{\s*display: none/);
  });

  it("nothing scrolls sideways any more: no scrollable region, no minimum width", () => {
    expect(markup).not.toMatch(/tabindex|role="region"|scrolls sideways/i);
    expect(ruleBody(".tree")).not.toMatch(/overflow-x:\s*auto/);
    expect(ruleBody(".tree svg")).not.toMatch(/min-width/);
  });
});

describe("the quote band on a phone", () => {
  it("is smaller, with room above it, and keeps a readable caption", () => {
    const markup = html(QuoteBand);
    expect(text(markup)).toContain(
      "Your treasury signs. Your browser checks. NEAR Intents settles.",
    );
    const phone = css.slice(css.indexOf("/* On a phone the quote is smaller"));
    const block = phone.slice(0, phone.indexOf("/* 8. How it works"));
    expect(block).toContain("max-width: 767px");
    expect(block).toContain("font-size: clamp(24px, 6vw, 44px)");
    expect(block).toContain("line-height: 1.25");
    expect(block).toMatch(/padding-block:\s*max\(112px/);
    expect(ruleBody(".band p")).toContain("font-size: 15px");
  });
});

describe("the story is a timeline, not a pinned stage", () => {
  const markup = html(StorySection);

  it("is an ordered list of four self-contained steps, each with a marker, text and its own card", () => {
    expect(markup).toContain('id="story"');
    expect(markup.match(/<li class="rev tl-step"/g)).toHaveLength(4);
    expect(markup.match(/class="tl-visual"/g)).toHaveLength(4);
    expect(markup.match(/class="tl-card"/g)).toHaveLength(4);
    for (const dt of ["NOV 1", "NOV 4", "NOV 26", "NOV 26, MOMENTS LATER"])
      expect(markup).toContain(`<span class="dt">${dt}</span>`);
    // The story's own words are all there, in full.
    const words = text(markup);
    for (const sentence of [
      "He funds it with USDC on NEAR (USDT from BNB Smart Chain works too). It arrives as USDC in Northwind's treasury on NEAR Intents, ready for payroll.",
      "She accepts the invite and adds her NEAR account. Kelvin's treasury wallet signs her address onto the payee list. Nobody else can change it.",
      "Quotes arrive with their fees. Kelvin's browser verifies every one. All four checks pass, so he approves each payout in his wallet, and pays no gas.",
      "Ada's payout passes through the veil and isn't publicly linked to Northwind. Kwame's direct payout stays visible on the NEAR explorer, as he chose. Five payslips are ready.",
    ])
      expect(words, sentence).toContain(sentence);
    // The images stay, with their alt text.
    expect(markup).toContain('alt="Kelvin, the example company&#x27;s founder, at his desk"');
    expect(markup).toContain('alt="Ada, an example contractor, working on a sofa"');
  });

  it("keeps saying that the people and amounts are examples, with the privacy condition", () => {
    expect(text(markup)).toContain("Example company and people.");
    expect(text(markup)).toContain("Private means no public source we checked");
  });

  it("has no scroll-linked script, no pinning, no scaling and no stacking tricks", () => {
    const code = read("landing/story.tsx");
    expect(code).not.toContain('"use client"');
    for (const banned of ["IntersectionObserver", "useEffect", "useState", "requestAnimationFrame"])
      expect(code, banned).not.toContain(banned);
    const story = css.slice(css.indexOf("/* 4. Story"), css.indexOf("/* 5. Features */"));
    expect(story).not.toMatch(/position:\s*sticky|scale\(|z-index|@keyframes|animation:/);
    expect(story).not.toMatch(/\.(stage|scene|chap|dots)\b/);
    expect(css).not.toMatch(/\.(stage|scene|chap)\b[^-]/);
  });

  it("nothing on the landing page is sticky", () => {
    expect(rules(css).filter((r) => /position:\s*sticky/.test(r.body))).toEqual([]);
  });

  it("stacks under the tablet width: text first, then the picture, beside a rail", () => {
    const small = css.slice(css.indexOf("@media (max-width: 980px)"));
    expect(small).toMatch(
      /\.tl-step,\s*\.tl-step:nth-child\(even\)\s*\{[^}]*grid-template-columns:\s*24px minmax\(0, 1fr\)/,
    );
    expect(small).toMatch(/\.tl-step \.tl-visual,[^{]*\{[^}]*grid-row:\s*2/);
  });

  it("its labels in the picture are plain blocks, not outlined pills", () => {
    expect(markup).toContain('class="flow-node"');
    expect(markup).not.toContain("chipd");
    expect(ruleBody(".flow-node")).not.toMatch(/border(?!-radius)|var\(--r-pill\)/);
  });
});

describe("the marquee is gone", () => {
  it("no component, no style, no animation, no token", () => {
    expect(read("landing/sections.tsx")).not.toMatch(/Marquee|mq-/);
    expect(read("app/page.tsx")).not.toContain("Marquee");
    expect(css).not.toMatch(/\.mq\b|\.mq-|@keyframes mq\b|marquee/i);
    expect(read("design/tokens.ts")).not.toMatch(/marquee/i);
    for (const phrase of [
      "Payslips and CSV",
      "Private receipts",
      "Borderless payroll on NEAR",
      "Quotes checked in your browser",
    ])
      expect(text(html(Hero)) + text(html(StorySection))).not.toContain(phrase);
  });
});

describe("the page keeps its rules", () => {
  it("has no inline style on any landing component (the CSP forbids it)", () => {
    for (const file of ["nav.tsx", "sections.tsx", "story.tsx", "pitch.tsx", "hero-extras.tsx"])
      expect(read(`landing/${file}`), file).not.toMatch(/\bstyle=\{|\bstyle="/);
  });

  it("ships a favicon in the site's own colours, so no /favicon.ico request is left to fail", () => {
    const icon = read("app/icon.svg");
    const colours = [...icon.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0].toUpperCase());
    const tokens: string[] = Object.values(color).map((c) => c.toUpperCase());
    expect(colours.length).toBeGreaterThan(0);
    for (const c of colours) expect(tokens, c).toContain(c);
  });
});

describe("the cards hydrate as one island, not one per card", () => {
  it("Card is plain markup, and one client component drives every tilt on the page", () => {
    const card = read("ui/card.tsx");
    expect(card).not.toContain('"use client"');
    expect(card).not.toMatch(/useEffect|useRef|useState/);
    const fx = read("landing/card-fx.tsx");
    expect(fx.startsWith('"use client"')).toBe(true);
    expect(fx).toContain('document.querySelectorAll<HTMLElement>(".card-fx")');
    expect(fx).toContain("prefersReducedMotion()");
    expect(fx).toContain("(hover: hover) and (pointer: fine)");
    const page = read("app/page.tsx");
    expect(page.match(/<CardFx \/>/g)).toHaveLength(1);
  });
});

describe("no text is ever half transparent (axe measures contrast mid-animation)", () => {
  it("the hero's panel and trust line move into place with a transform only", () => {
    for (const selector of [
      ".hero .hp-frame",
      ".hero .hp-card",
      ".hero .trust-line",
      ".hero .cta .hero-link",
    ]) {
      // A selector can have a layout rule and a motion rule: read all of them.
      const body = ruleBody(selector);
      expect(body, selector).toMatch(/animation:\s*lp-rise-t /);
      expect(body, selector).not.toMatch(/lp-rise\b(?!-)/);
    }
  });
});

describe("a check mark is an icon, not a typed character", () => {
  /** Every product file under src (tests excluded). */
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  const product = files(src).filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\.ts$/.test(f));

  it("no typed check mark is left in any component or stylesheet", () => {
    const hits = product
      .filter((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .some((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /[✓✔]/.test(l)),
      )
      .map((f) => relative(src, f));
    expect(hits).toEqual([]);
  });

  it("the thin SVG check is Phosphor Check in the regular weight, in the text colour, sized to the text", () => {
    const icon = read("ui/icon.tsx");
    expect(icon).toMatch(/export function CheckMark\(\)/);
    expect(icon).toMatch(/weight="regular"/);
    const tick = read("styles/ui.css").match(/\.tick \{([^}]*)\}/)?.[1] ?? "";
    expect(tick).toContain("width: 1.1em");
    expect(tick).toContain("height: 1.1em");
    expect(tick).toContain("vertical-align");
  });

  it("the SIGNED BY TREASURY badge and the finished setup step use it, and keep their copy", () => {
    expect(html(StorySection)).toMatch(
      /class="stamp-success"><svg[^>]*class="tick"[^>]*>[\s\S]*?<\/svg>SIGNED BY TREASURY</,
    );
    const setup = read("screens/setup.tsx");
    expect(setup).toContain("<CheckMark />");
    expect(setup).toContain('className="step-success"');
    expect(read("styles/w6.css")).toMatch(
      /\.steps li\[data-state="success"\]::before \{\s*content: none;/,
    );
    expect(read("styles/w6.css")).toMatch(
      /\.steps \.step-success \{[^}]*color: var\(--success-text\)/,
    );
  });
});

describe("no pill, chip or button look without something to click", () => {
  // The rule for the whole page: if it looks like a button or a chip, it is a link or a button; if it
  // isn't clickable, it must not look like one.
  const tsx = ["nav.tsx", "sections.tsx", "story.tsx", "pitch.tsx", "hero-extras.tsx"].map((f) => ({
    file: f,
    code: read(`landing/${f}`),
  }));

  it("no element carries a chip, pill or btn class unless it is a link or a button", () => {
    const bad: string[] = [];
    for (const { file, code } of tsx) {
      for (const m of code.matchAll(
        /<(\w+)\b[^>]*className="[^"]*\b(chip\w*|pchip\w*|\w*-pill|pill\w*|btn\w*)\b[^"]*"[^>]*>/g,
      )) {
        const tag = m[1] ?? "";
        // SVG shapes are drawing parts; the Button components render an <a> or a <button>.
        if (["a", "button", "rect", "path", "g"].includes(tag)) continue;
        bad.push(`${file}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every rounded-pill rule in the landing styles belongs to a link, a button or a labelled static badge", () => {
    // Static badges: the two small labels of the sample workspace (no border or hover on the first,
    // an amber hairline and no hover on the second); each is a picture of a label, inside a panel that
    // is announced as a sample.
    const STATIC = new Set([".hp-badge", ".private-badge"]);
    const offenders: string[] = [];
    for (const r of rules(css)) {
      if (!/border-radius:\s*(var\(--r-pill\)|999px|99px)/.test(r.body)) continue;
      for (const s of r.selectors) {
        const interactive =
          /(^|[\s>])(a|button)\b|\.btn|\.nav-menu-btn|\.nav-open|\.drawer|\.skip-link|:hover|\.faq|summary/.test(
            s,
          );
        if (!interactive && !STATIC.has(s)) offenders.push(s);
      }
    }
    // What is left are drawings (a track, a dot) and the headline underline, none of them a control.
    expect(offenders.filter((s) => /chip|pill|tag|badge|btn|button/.test(s))).toEqual([]);
  });

  it("the hero has exactly one button-shaped thing: 'Open a treasury'", () => {
    const hero = html(Hero);
    expect(hero.match(/\bbtn\b/g)).toHaveLength(2); // class="btn btn-light"
    expect(hero.match(/<button/g)).toBeNull();
  });
});

describe("the sign-up screen and email", () => {
  const auth = read("screens/auth-screens.tsx");
  const setup = read("screens/setup.tsx");

  it("the sign-up intro is the founder's, and says nothing about email delivery", () => {
    const flat = auth.replace(/\s+/g, " ");
    expect(flat).toContain(
      "Next you&apos;ll create your wallet and pay your first contractor. Your email is only for signing in and notices.",
    );
    const signUp = auth.slice(
      auth.indexOf("function SignUpCard()"),
      auth.indexOf("function SignUpCard()") + 3000,
    );
    expect(signUp).not.toMatch(/Email delivery|confirmation email|emailDelivery/);
  });

  it("while delivery is off, no screen says an email was sent or asks to check email", () => {
    for (const [name, code] of [
      ["auth-screens", auth],
      ["setup", setup],
    ] as const) {
      // Each "we sent / check your inbox / on its way" line sits inside a delivery-on branch.
      const flat = code.replace(/\s+/g, " ");
      expect(flat, name).not.toMatch(/no confirmation email was sent/);
      expect(flat, name).not.toMatch(
        /Email delivery is not set up yet[^.]*\b(we|was|were|has been) sent/i,
      );
    }
    // The setup notice, delivery off: nothing was sent, and it doesn't claim to have been.
    const off = setup.slice(
      setup.indexOf(") : ("),
      setup.indexOf("</div>", setup.indexOf(") : (")),
    );
    expect(off.replace(/\s+/g, " ")).toContain(
      "is saved for signing in and notices. Your account works without confirming it",
    );
    expect(off).not.toMatch(/\bsent\b|inbox|check your email/i);
  });
});
