// Shared code for the wallet pins (slice W6, part 2): fetch the near-connect manifest and every
// executor, hash them, read the hosts each one names (with line and column), apply the hand-written
// review (src/wallet/wallets.review.json), and compare with the committed lock
// (src/wallet/wallets.lock.json). Used by scripts/wallets-refresh.mjs and by the tests.
import { createHash } from "node:crypto";

export const MANIFEST_URL =
  "https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json";

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Hosts that appear in bundled libraries as comments, documentation links or licences. */
const NOISE =
  /(^|\.)(w3\.org|reactjs\.org|mozilla\.org|github\.com|github\.io|npmjs\.com|ethereum\.org|stackoverflow\.com|json-schema\.org|ietf\.org|apache\.org|jquery\.com|opensource\.org|googleapis\.com|facebook\.com|twitter\.com|t\.me|discord\.com|youtube\.com|medium\.com|wikipedia\.org|tc39\.es|schema\.org|example\.com|nomicon\.io|bit\.ly)$|^(localhost|0\.0\.0\.0|127\.0\.0\.1)$/;

/** Every network host an executor names, with where it first appears. */
export function scanHosts(text) {
  const found = new Map();
  const re = /(https?|wss?):\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  for (const m of text.matchAll(re)) {
    const host = m[2];
    if (NOISE.test(host)) continue;
    const origin = `${m[1]}://${host}`;
    const entry = found.get(origin);
    if (entry) {
      entry.count += 1;
      continue;
    }
    const before = text.slice(0, m.index);
    const line = before.split("\n").length;
    const col = m.index - before.lastIndexOf("\n");
    const context = text
      .slice(Math.max(0, m.index - 60), m.index + 60)
      .replace(/\s+/g, " ")
      .trim();
    found.set(origin, { origin, count: 1, line, col, context });
  }
  return [...found.values()].sort((a, b) => a.origin.localeCompare(b.origin));
}

/** A static look at whether the code handles NEP-413 signMessage with our fields. */
export function nep413Signals(text) {
  const count = (re) => (text.match(re) ?? []).length;
  return {
    signMessage: count(/signMessage/g),
    nonce: count(/nonce/g),
    recipient: count(/recipient/g),
  };
}

/**
 * A wallet's manifest may list addresses it is allowed to open that point at the developer's own
 * computer (localhost, *.localhost, *.local). A production bridge never permits opening one, and a
 * local address must not appear anywhere in a production build, so they are dropped from the lock.
 */
export function isLocalTarget(target) {
  let host;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return false; // An app link such as hotwallet:// has no host to be local.
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}
export function withoutLocalOrigins(perms) {
  if (!Array.isArray(perms.allowsOpen)) return perms;
  return { ...perms, allowsOpen: perms.allowsOpen.filter((t) => !isLocalTarget(t)) };
}

const FORBIDDEN_PERMISSIONS = ["usb", "hid", "bluetooth", "walletConnect"];

export const executorFile = (id, version, sha) => `${id}-${version}-${sha}.js`;
export const iconFile = (id, sha, ext) => `${id}-${sha.slice(0, 12)}.${ext}`;

export async function fetchBytes(url) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    type: res.headers.get("content-type") ?? "",
  };
}

const extOf = (url, type) => {
  const m = /\.(png|svg|webp|jpg|jpeg|gif)(\?|$)/i.exec(url);
  if (m) return m[1].toLowerCase();
  if (/svg/.test(type)) return "svg";
  if (/png/.test(type)) return "png";
  if (/webp/.test(type)) return "webp";
  return "png";
};

/**
 * Builds the lock from a fetched manifest. `fetched` maps wallet id to
 * { executor: Buffer, icon?: { bytes, ext } }.
 */
export function buildLock({ manifest, fetched, review, fetchedAt }) {
  const wallets = manifest.wallets.map((w) => {
    const r = review.wallets[w.id];
    const got = fetched.get(w.id);
    const text = got ? got.executor.toString("utf8") : "";
    const sha = got ? sha256Hex(got.executor) : "";
    const hosts = scanHosts(text).map((h) => {
      let verdict = "unreviewed";
      let note = "";
      if (r?.connect.includes(h.origin)) verdict = "connect";
      else if (r?.img.includes(h.origin)) verdict = "img";
      else if (r?.frame.includes(h.origin)) verdict = "frame";
      else if (r && Object.hasOwn(r.ignore, h.origin)) {
        verdict = "ignored";
        note = r.ignore[h.origin];
      }
      return { ...h, verdict, note };
    });
    const signals = nep413Signals(text);
    const perms = withoutLocalOrigins(w.permissions ?? {});
    const problems = [];
    if (!r) problems.push("no review entry");
    if (w.features?.signMessage !== true) problems.push("manifest does not declare signMessage");
    if (signals.signMessage === 0 || signals.nonce === 0 || signals.recipient === 0)
      problems.push("executor code does not reference signMessage, nonce and recipient");
    for (const p of FORBIDDEN_PERMISSIONS)
      if (perms[p]) problems.push(`requests the ${p} permission`);
    const unreviewed = hosts.filter((h) => h.verdict === "unreviewed").map((h) => h.origin);
    if (unreviewed.length > 0) problems.push(`unreviewed hosts: ${unreviewed.join(", ")}`);
    const wanted = r?.enabled === true;
    const enabled = wanted && problems.length === 0;
    const reason = enabled
      ? r.reason
      : wanted
        ? `Excluded by the checks: ${problems.join("; ")}.`
        : (r?.reason ?? "Not reviewed.");
    return {
      id: w.id,
      name: w.name,
      description: w.description ?? "",
      website: w.website ?? "",
      version: w.version,
      kind: r?.kind ?? "unknown",
      type: w.type ?? "sandbox",
      features: w.features ?? {},
      permissions: perms,
      platform: w.platform ?? {},
      icon:
        got?.icon && enabled
          ? {
              source: w.icon,
              sha256: sha256Hex(got.icon.bytes),
              file: iconFile(w.id, sha256Hex(got.icon.bytes), got.icon.ext),
            }
          : { source: w.icon, sha256: "", file: "" },
      executor: {
        source: w.executor,
        sha256: sha,
        bytes: got ? got.executor.length : 0,
        file: enabled ? executorFile(w.id, w.version, sha) : "",
        // Set only when the pinned file is not what the manifest serves today.
        upstream: got?.upstream ?? null,
      },
      nep413: signals,
      hosts,
      allow: enabled
        ? { connect: r.connect, img: r.img, frame: r.frame }
        : { connect: [], img: [], frame: [] },
      enabled,
      reason,
    };
  });
  return {
    manifest: { url: MANIFEST_URL, version: manifest.version, fetchedAt },
    wallets,
  };
}

/** Human-readable differences between two locks: what changed upstream since the last pin. */
export function diffLocks(oldLock, newLock) {
  const lines = [];
  if (oldLock.manifest.version !== newLock.manifest.version)
    lines.push(`manifest version ${oldLock.manifest.version} -> ${newLock.manifest.version}`);
  const before = new Map(oldLock.wallets.map((w) => [w.id, w]));
  const after = new Map(newLock.wallets.map((w) => [w.id, w]));
  for (const id of after.keys())
    if (!before.has(id)) lines.push(`NEW wallet in the manifest: ${id}`);
  for (const id of before.keys())
    if (!after.has(id)) lines.push(`REMOVED from the manifest: ${id}`);
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) continue;
    if (was.executor.sha256 !== now.executor.sha256)
      lines.push(
        `EXECUTOR CHANGED ${id}: sha256 ${was.executor.sha256.slice(0, 12)}... -> ${now.executor.sha256.slice(0, 12)}... (${was.executor.bytes} -> ${now.executor.bytes} bytes)`,
      );
    if (was.version !== now.version) lines.push(`${id}: version ${was.version} -> ${now.version}`);
    if (now.executor.upstream && now.executor.upstream.sha256 !== was.executor.upstream?.sha256)
      lines.push(
        `UPSTREAM MOVED ${id}: the manifest now serves sha256 ${now.executor.upstream.sha256.slice(0, 12)}... (pinned file stays: ${now.executor.sha256.slice(0, 12)}...)`,
      );
    const oldHosts = new Set(was.hosts.map((h) => h.origin));
    const newHosts = new Set(now.hosts.map((h) => h.origin));
    for (const h of newHosts) if (!oldHosts.has(h)) lines.push(`${id}: NEW host ${h}`);
    for (const h of oldHosts) if (!newHosts.has(h)) lines.push(`${id}: host gone ${h}`);
    if (was.enabled !== now.enabled)
      lines.push(
        `${id}: ${was.enabled ? "enabled" : "excluded"} -> ${now.enabled ? "enabled" : "excluded"} (${now.reason})`,
      );
  }
  return lines;
}

export { extOf };
