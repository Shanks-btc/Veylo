// Lighthouse, mobile (its default emulation and throttling), on the production landing page.
// Bars (W2 Part D): Performance >= 90, LCP < 2.5 s, CLS < 0.05.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { serve } from "./serve.mjs";

const web = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const { server, origin } = await serve();
const chrome = await chromeLauncher.launch({
  chromePath: CHROME,
  chromeFlags: (process.env.LH_FLAGS ?? "--headless=new").split(" ").filter(Boolean),
});
const RUNS = 5; // The median of five: one slow run on a busy machine can't decide the result.
const runs = [];
try {
  for (let i = 0; i < RUNS; i += 1) {
    const r = await lighthouse(`${origin.replace("127.0.0.1", "localhost")}/`, {
      port: chrome.port,
      onlyCategories: ["performance", "accessibility", "seo", "best-practices"],
      output: "json",
    });
    const a = r.lhr.audits;
    if (r.lhr.runtimeError)
      throw new Error(`lighthouse: ${r.lhr.runtimeError.code} ${r.lhr.runtimeError.message}`);
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
  server.close();
}
const median = (k) => [...runs.map((r) => r[k])].sort((x, y) => x - y)[Math.floor(RUNS / 2)];
const summary = {
  runs,
  median: Object.fromEntries(Object.keys(runs[0]).map((k) => [k, median(k)])),
};
writeFileSync(
  join(web, "..", "..", "design", "screenshots", "lighthouse-results.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
const m = summary.median;
if (m.performance < 90 || m.lcpMs >= 2500 || m.cls >= 0.05) process.exit(1);
