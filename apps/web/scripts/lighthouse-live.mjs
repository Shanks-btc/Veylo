// Lighthouse, mobile (its default emulation and throttling), against a LIVE URL (slice W7).
//
//   LIVE_URL=https://... node apps/web/scripts/lighthouse-live.mjs
//
// Five runs, all reported, and the median is judged against the floor in L47: Performance >= 85,
// LCP < 2.5 s, CLS < 0.05. Real headers, real network, real host: nothing is served from this
// computer. Output goes to LIVE_OUT (a folder) when set.
//
// If Chrome 157 and Lighthouse 13.5 lose the navigation start because the page sends a
// Cross-Origin-Opener-Policy header (error NO_NAVSTART, see L47), set LH_THROUGH_PROXY=1: runs go
// through a pass-through proxy on this computer that forwards every request to the live host
// unchanged and drops only that one response header. The product keeps the header; only the
// measurement does without it, and the report says so.
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";

const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const live = new URL(process.env.LIVE_URL ?? "");
if (live.protocol !== "https:") throw new Error("LIVE_URL must be an https URL");
const FLOOR = 85;
const RUNS = 5;

let target = live.href;
let proxy;
if (process.env.LH_THROUGH_PROXY === "1") {
  proxy = createServer((req, res) => {
    const up = httpsRequest(
      {
        host: live.host,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: live.host },
      },
      (r) => {
        const headers = { ...r.headers };
        delete headers["cross-origin-opener-policy"];
        res.writeHead(r.statusCode ?? 502, headers);
        r.pipe(res);
      },
    );
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  target = `http://localhost:${proxy.address().port}/`;
}

// A warm-up: the first answer after a quiet period comes from the origin, not the CDN edge, and a
// visitor after the first one gets the edge. One plain request fills it. Not part of the five runs.
if (process.env.LH_WARMUP !== "0") {
  for (let i = 0; i < 2; i += 1) await fetch(target).then((r) => r.arrayBuffer());
}

const chrome = await chromeLauncher.launch({
  chromePath: CHROME,
  chromeFlags: (process.env.LH_FLAGS ?? "--headless=new").split(" ").filter(Boolean),
});
const runs = [];
try {
  // A freshly started Chrome pays for its own start-up (GPU process, first script compile) in
  // whichever page it loads first, and in three sets of five that was always run 1 (TBT 2.6 to
  // 9.7 s against 0.2 to 0.4 s for the rest). One discarded run of a light page (no globe) warms
  // the browser, as it would be for a visitor whose browser is already running.
  if (process.env.LH_WARMUP !== "0") {
    await lighthouse(new URL("terms", target).href, {
      port: chrome.port,
      onlyCategories: ["performance"],
      output: "json",
    });
  }
  for (let i = 0; i < RUNS; i += 1) {
    const r = await lighthouse(target, {
      port: chrome.port,
      onlyCategories: ["performance", "accessibility", "seo", "best-practices"],
      output: "json",
    });
    if (r.lhr.runtimeError)
      throw new Error(`lighthouse: ${r.lhr.runtimeError.code} ${r.lhr.runtimeError.message}`);
    const a = r.lhr.audits;
    runs.push({
      performance: Math.round(r.lhr.categories.performance.score * 100),
      accessibility: Math.round(r.lhr.categories.accessibility.score * 100),
      seo: Math.round(r.lhr.categories.seo.score * 100),
      bestPractices: Math.round(r.lhr.categories["best-practices"].score * 100),
      lcpMs: Math.round(a["largest-contentful-paint"].numericValue),
      cls: Math.round(a["cumulative-layout-shift"].numericValue * 1000) / 1000,
      tbtMs: Math.round(a["total-blocking-time"].numericValue),
      fcpMs: Math.round(a["first-contentful-paint"].numericValue),
    });
  }
} finally {
  await chrome.kill();
  proxy?.close();
}
const median = (k) => [...runs.map((r) => r[k])].sort((x, y) => x - y)[Math.floor(RUNS / 2)];
const summary = {
  url: live.href,
  throughProxyWithoutCoopHeader: proxy !== undefined,
  floor: FLOOR,
  runs,
  median: Object.fromEntries(Object.keys(runs[0]).map((k) => [k, median(k)])),
};
if (process.env.LIVE_OUT) {
  mkdirSync(process.env.LIVE_OUT, { recursive: true });
  writeFileSync(
    join(process.env.LIVE_OUT, "lighthouse-live.json"),
    JSON.stringify(summary, null, 2),
  );
}
console.log(JSON.stringify(summary, null, 2));
const m = summary.median;
if (m.performance < FLOOR || m.lcpMs >= 2500 || m.cls >= 0.05) process.exit(1);
