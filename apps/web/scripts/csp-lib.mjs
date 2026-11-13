// The web app's Content-Security-Policy (T-7, L41), applied after `next build` to the static
// export. Next's App Router emits inline <script> payloads, so each one is pinned by its SHA-256:
// no 'unsafe-inline', no 'unsafe-eval', and the build fails on anything it can't pin (an inline
// event handler, a javascript: URL, or an external script from another origin).
import { createHash } from "node:crypto";

// Wallet code runs on the wallet bridge origin (L44), so the app origin connects to no wallet host:
// it only frames the bridge (frame-src) and talks to it by postMessage.

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const EXECUTABLE_TYPE = /^(|text\/javascript|application\/javascript|module)$/i;

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : undefined;
}

/** Hashes every inline executable script; throws on anything a strict policy can't allow. */
export function inspectHtml(html, file = "page") {
  const hashes = [];
  for (const m of html.matchAll(SCRIPT)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const src = attr(attrs, "src");
    const type = (attr(attrs, "type") ?? "").trim();
    if (src !== undefined) {
      if (/^(https?:)?\/\//i.test(src) || /^javascript:/i.test(src)) {
        throw new Error(`${file}: external or javascript: script src ${src}`);
      }
      if (body.trim() !== "") throw new Error(`${file}: script with both src and a body`);
      continue;
    }
    if (!EXECUTABLE_TYPE.test(type)) continue; // Data blocks (e.g. application/json) never run.
    hashes.push(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  if (/<[^>]+\son[a-z]+\s*=/i.test(html))
    throw new Error(`${file}: inline event handler attribute`);
  // style-src is 'self' only: an inline <style> or style attribute would be blocked, so fail here.
  if (/<style\b/i.test(html)) throw new Error(`${file}: inline <style> element`);
  if (/<[^>]+\sstyle\s*=/i.test(html)) throw new Error(`${file}: inline style attribute`);
  if (/(href|src|action)\s*=\s*["']?\s*javascript:/i.test(html))
    throw new Error(`${file}: javascript: URL`);
  return [...new Set(hashes)];
}

/**
 * A production build only ever names https origins that aren't this computer. The local wallet
 * test (pnpm dev:wallet) sets VEYLO_LOCAL_WALLET_TEST=1 to build with local origins, into its own
 * folder; pnpm verify then scans the production output for any local origin.
 */
export function assertOrigins(origins, local = process.env.VEYLO_LOCAL_WALLET_TEST === "1") {
  if (local) return;
  for (const o of origins) {
    const u = new URL(o);
    const here = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" || here)
      throw new Error(
        `${o} isn't allowed in a production build: only https origins that aren't local`,
      );
  }
}

export function buildPolicy({ apiOrigin, nearRpcUrl, archivalRpcUrl, bridgeOrigin, scriptHashes }) {
  const rpcOrigin = new URL(nearRpcUrl).origin;
  const bridge = new URL(bridgeOrigin).origin;
  if (bridge === new URL(apiOrigin).origin)
    throw new Error("the wallet bridge can't be the API origin");
  const connect = ["'self'", new URL(apiOrigin).origin, rpcOrigin];
  // The proof and verify pages read old transactions from an archival node (read-only).
  if (archivalRpcUrl) connect.push(new URL(archivalRpcUrl).origin);
  return [
    "default-src 'none'",
    `script-src 'self' ${scriptHashes.join(" ")}`.trim(),
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${[...new Set(connect)].join(" ")}`,
    `frame-src ${bridge}`,
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Puts the policy first in <head>, before any script, so it governs the whole page. */
export function applyPolicy(html, policy, file = "page") {
  if (/http-equiv\s*=\s*["']?content-security-policy/i.test(html)) {
    throw new Error(`${file}: already has a CSP meta tag`);
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', "&quot;")}">`;
  const at = html.search(/<head[^>]*>/i);
  if (at < 0) throw new Error(`${file}: no <head>`);
  const end = html.indexOf(">", at) + 1;
  const before = html.slice(0, end);
  const after = html.slice(end);
  // A <meta charset> must stay in the first bytes; keep it ahead of the policy.
  const charset = /^\s*<meta charset="[^"]*"\s*\/?>/i.exec(after);
  return charset
    ? before + charset[0] + meta + after.slice(charset[0].length)
    : before + meta + after;
}

/**
 * Landing page only (slice W6, W5 follow-up 1): moves Next's async hydration scripts behind the
 * window load event, so the first paint and the LCP text don't compete with React's start-up work.
 * The page is complete HTML without script; hydration adds only the nav menu, the story scenes and
 * the globe. The loader is one inline script, pinned by hash like every other inline script.
 */
export function deferHydration(html) {
  const urls = [];
  let out = html.replace(
    /<script src="(\/_next\/static\/[^"]+\.js)"((?: id="[^"]*")?) async=""><\/script>/g,
    (_m, src, id) => {
      urls.push(`${src}${id ? "|" + /id="([^"]*)"/.exec(id)?.[1] : ""}`);
      return "";
    },
  );
  if (urls.length === 0) return html;
  out = out.replace(/<link rel="preload" as="script"[^>]*\/?>/g, "");
  const list = JSON.stringify(urls);
  const loader =
    "<script>(function(){var u=" +
    list +
    ";function go(){u.forEach(function(s){var p=s.split('|');var e=document.createElement('script');e.src=p[0];if(p[1])e.id=p[1];e.async=true;document.head.appendChild(e)})}" +
    "if(document.readyState==='complete')setTimeout(go,0);else addEventListener('load',function(){setTimeout(go,0)},{once:true})})()</script>";
  return out.includes("</body>") ? out.replace("</body>", `${loader}</body>`) : out + loader;
}
