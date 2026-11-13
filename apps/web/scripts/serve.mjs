// A tiny static server for out/, for the browser checks: clean URLs and the vercel.json headers,
// so pages are tested the way they'll be served. Local only (127.0.0.1).
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const skip = (process.env.SERVE_WITHOUT ?? "").split(",");
/** Every rule of a vercel.json, so a page can have its own headers (the wallet bridge does). */
const rulesFrom = (file) =>
  JSON.parse(readFileSync(file, "utf8")).headers.map((rule) => ({
    // Vercel's "(.*)" in a source means any path.
    pattern: new RegExp(
      "^" +
        rule.source
          .split("(.*)")
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
    ),
    headers: rule.headers.filter((h) => !skip.includes(h.key)).map((h) => [h.key, h.value]),
  }));
const headersFor = (rules, pathname) =>
  Object.fromEntries(rules.filter((r) => r.pattern.test(pathname)).flatMap((r) => r.headers));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".ico": "image/x-icon",
};

function resolve(out, pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const base = join(out, clean);
  if (!base.startsWith(out)) return undefined;
  for (const p of [base, `${base}.html`, join(base, "index.html")]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return undefined;
}

/**
 * Serves a static export. Defaults to out/ with vercel.json's headers; pass `dir` and `headers`
 * (a vercel.json path) to serve another export, such as the bridge or the demo build.
 */
export function serve(port = 0, options = {}) {
  const out = options.dir ?? join(web, "out");
  const rules = rulesFrom(options.headers ?? join(web, "vercel.json"));
  const host = options.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const file = resolve(out, url.pathname === "/" ? "/index" : url.pathname);
    const h = { ...headersFor(rules, url.pathname), "cache-control": "no-store" };
    if (!file) {
      res.writeHead(404, { ...h, "content-type": TYPES[".html"] });
      res.end(
        existsSync(join(out, "404.html")) ? readFileSync(join(out, "404.html")) : "Not found",
      );
      return;
    }
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    // Compress text as the host does (Vercel), so performance is measured fairly.
    if (
      /text|javascript|json|xml|svg/.test(type) &&
      /gzip/.test(req.headers["accept-encoding"] ?? "")
    ) {
      res.writeHead(200, { ...h, "content-type": type, "content-encoding": "gzip" });
      res.end(gzipSync(readFileSync(file)));
      return;
    }
    res.writeHead(200, { ...h, "content-type": type });
    res.end(readFileSync(file));
  });
  return new Promise((ok) =>
    server.listen(port, host, () =>
      ok({
        server,
        origin: `http://${host === "::" ? "localhost" : host}:${server.address().port}`,
      }),
    ),
  );
}
