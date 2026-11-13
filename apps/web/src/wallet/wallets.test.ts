// The wallet pins (slice W6, part 2): every executor Veylo serves matches its SHA-256 pin, every
// host it names is reviewed, every wallet gets its own CSP, and the picker orders them as promised.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bridgePolicy, embeddedPolicy } from "../../scripts/bridge-csp.mjs";
import {
  ALL_WALLETS,
  ENABLED_WALLETS,
  MANIFEST_INFO,
  executorPath,
  getAWalletLinks,
  pickerOrder,
  walletById,
} from "./registry";
import review from "./wallets.review.json";

const pub = fileURLToPath(new URL("../../public", import.meta.url));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("the manifest and the review agree", () => {
  it("every wallet in the manifest has a hand review, and the review names no other wallet", () => {
    expect(ALL_WALLETS.map((w) => w.id).sort()).toEqual(Object.keys(review.wallets).sort());
    expect(MANIFEST_INFO.url).toContain("near-selector");
    expect(MANIFEST_INFO.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("enables the wallets that pass and excludes the rest, each with its reason", () => {
    expect(ENABLED_WALLETS.map((w) => w.id).sort()).toEqual(
      [
        "hot-wallet",
        "intear-wallet",
        "meteor-wallet",
        "mynearwallet",
        "near-mobile",
        "nightly-wallet",
        "okx-wallet",
      ].sort(),
    );
    for (const w of ALL_WALLETS.filter((x) => !x.enabled)) {
      expect(w.reason.length, `${w.id} needs a reason`).toBeGreaterThan(30);
      expect(w.executor.file, `${w.id} is excluded, so no executor is served`).toBe("");
    }
  });

  it("only wallets that declare signMessage and reference nonce and recipient are enabled", () => {
    for (const w of ENABLED_WALLETS) {
      expect(w.features.signMessage, w.id).toBe(true);
      expect(w.nep413.signMessage, w.id).toBeGreaterThan(0);
      expect(w.nep413.nonce, w.id).toBeGreaterThan(0);
      expect(w.nep413.recipient, w.id).toBeGreaterThan(0);
    }
  });

  it("no enabled wallet asks for hardware or relay permissions", () => {
    for (const w of ENABLED_WALLETS)
      for (const p of ["usb", "hid", "bluetooth", "walletConnect"])
        expect(w.permissions[p], `${w.id} ${p}`).toBeFalsy();
  });
});

describe("pinned executors (§15 rules 4, 5)", () => {
  it.each(ENABLED_WALLETS.map((w) => [w.id, w] as const))(
    "%s: the served executor matches its SHA-256 pin",
    (_id, w) => {
      const file = join(pub, "wallets", w.executor.file);
      expect(existsSync(file), `${w.executor.file} is missing`).toBe(true);
      const bytes = readFileSync(file);
      expect(sha(bytes)).toBe(w.executor.sha256);
      expect(w.executor.file).toContain(w.executor.sha256);
      expect(bytes.length).toBe(w.executor.bytes);
      expect(executorPath(w)).toBe(`/wallets/${w.executor.file}`);
    },
  );

  it("nothing else is served from /wallets: every file there is a pinned executor", () => {
    const pinned = new Set(ENABLED_WALLETS.map((w) => w.executor.file));
    const files = readdirSync(join(pub, "wallets"));
    expect(files.sort()).toEqual([...pinned].sort());
  });

  it("every enabled wallet has its icon on this origin, matching its hash", () => {
    for (const w of ENABLED_WALLETS) {
      expect(w.icon, w.id).toMatch(/^\/wallet-icons\//);
      const bytes = readFileSync(join(pub, w.icon));
      expect(sha(bytes), w.id).toBe(w.iconSha256);
    }
  });

  it("the Meteor executor stays the file that was tested against the real wallet in S-A2", () => {
    const meteor = walletById("meteor-wallet")!;
    expect(meteor.executor.sha256).toBe(
      "96210256a89cb382bb7fe95f29d6a2489319da87472fe77018b4cdcbf1672b50",
    );
  });
});

describe("hosts: every one an enabled wallet names is reviewed", () => {
  it("no enabled wallet has an unreviewed host", () => {
    for (const w of ENABLED_WALLETS)
      expect(
        w.hosts.filter((h) => h.verdict === "unreviewed").map((h) => h.origin),
        w.id,
      ).toEqual([]);
  });

  it("each allowed host is one the executor actually names, with its line and column recorded", () => {
    for (const w of ENABLED_WALLETS) {
      const named = new Set(w.hosts.map((h) => h.origin));
      for (const origin of [...w.allow.connect, ...w.allow.img, ...w.allow.frame])
        expect(named.has(origin), `${w.id} allows ${origin} but its code never names it`).toBe(
          true,
        );
      for (const h of w.hosts) {
        expect(h.line).toBeGreaterThan(0);
        expect(h.col).toBeGreaterThan(0);
        if (h.verdict === "ignored")
          expect(h.note.length, `${w.id} ${h.origin}`).toBeGreaterThan(5);
      }
    }
  });

  it("the recorded line and column really point at the host in the vendored file", () => {
    for (const w of ENABLED_WALLETS) {
      const lines = readFileSync(join(pub, "wallets", w.executor.file), "utf8").split("\n");
      for (const h of w.hosts.slice(0, 6)) {
        const line = lines[h.line - 1] ?? "";
        expect(
          line.slice(h.col - 1, h.col - 1 + h.origin.length + 2),
          `${w.id} ${h.origin}`,
        ).toContain(h.origin.replace(/^[a-z]+:\/\//, ""));
      }
    }
  });
});

describe("one bridge page per wallet, each with its own CSP", () => {
  const opts = {
    appOrigin: "https://app.veylo.test",
    nearRpcUrl: "https://rpc.fastnear.com",
    apiOrigin: "https://api.veylo.test",
  };

  it("a wallet's page connects only to that wallet's reviewed hosts and NEAR RPC", () => {
    for (const w of ENABLED_WALLETS) {
      const p = bridgePolicy({ ...opts, wallet: w });
      expect(p.connect, w.id).toEqual([
        ...new Set([...w.allow.connect, "https://rpc.fastnear.com"]),
      ]);
      expect(p.header).not.toContain("api.veylo.test");
      expect(p.header).toContain("frame-ancestors https://app.veylo.test");
    }
  });

  it("one wallet's hosts never appear on another wallet's page", () => {
    const hot = bridgePolicy({ ...opts, wallet: walletById("hot-wallet")! }).header;
    const meteor = bridgePolicy({ ...opts, wallet: walletById("meteor-wallet")! }).header;
    expect(hot).not.toContain("meteorwallet.app");
    expect(meteor).not.toContain("herewallet.app");
    expect(meteor).not.toContain("h4n.app");
  });

  it("the Veylo wallet page loads and connects to nothing but itself", () => {
    const p = embeddedPolicy({ appOrigin: "https://app.veylo.test" });
    expect(p.header).toContain("connect-src 'none'");
    expect(p.header).toContain("script-src 'self';");
    expect(p.header).not.toContain("unsafe-inline");
    expect(p.header).toContain("frame-src 'none'");
    expect(p.header).toContain("frame-ancestors https://app.veylo.test");
  });
});

describe("the picker", () => {
  it("lists HOT first and Meteor second, on every device", () => {
    for (const mobile of [true, false]) {
      const order = pickerOrder(ENABLED_WALLETS, { mobile }).map((w) => w.id);
      expect(order.slice(0, 2)).toEqual(["hot-wallet", "meteor-wallet"]);
      expect(order).toHaveLength(ENABLED_WALLETS.length);
    }
  });

  it("on a phone, wallets with an app come before browser extensions", () => {
    const rest = pickerOrder(ENABLED_WALLETS, { mobile: true })
      .slice(2)
      .map((w) => w.kind);
    expect(rest.indexOf("extension")).toBeGreaterThan(rest.lastIndexOf("app"));
  });

  it("every enabled wallet shows a name and an icon", () => {
    for (const w of ENABLED_WALLETS) {
      expect(w.name.length).toBeGreaterThan(1);
      expect(w.icon).not.toBe("");
    }
  });

  it("'Need a wallet? Get one' links only to each wallet's own https website", () => {
    const links = getAWalletLinks();
    expect(links.length).toBeGreaterThanOrEqual(5);
    for (const l of links) expect(l.url).toMatch(/^https:\/\//);
    expect(links.map((l) => l.name)).toContain("HOT Wallet");
  });
});

describe("docs/WALLETS.md", () => {
  it("is exactly what the committed lock and review render to, so it can't drift", async () => {
    const { renderWalletsDoc } = await import("../../scripts/wallets-doc-lib.mjs");
    const lock = (await import("./wallets.lock.json")).default;
    const doc = readFileSync(
      join(fileURLToPath(new URL("../../../..", import.meta.url)), "docs", "WALLETS.md"),
      "utf8",
    );
    expect(doc).toBe(renderWalletsDoc(lock as never, review as never));
  });

  it("names every enabled wallet and every excluded one with its reason", () => {
    const doc = readFileSync(
      join(fileURLToPath(new URL("../../../..", import.meta.url)), "docs", "WALLETS.md"),
      "utf8",
    );
    for (const w of ALL_WALLETS) {
      expect(doc, w.id).toContain(`\`${w.id}\``);
      if (!w.enabled) expect(w.reason.length, `${w.id} has a reason`).toBeGreaterThan(20);
    }
  });
});

describe("addresses on the developer's own computer", () => {
  it("no wallet may be allowed to open one (a production build names no local origin)", async () => {
    const { isLocalTarget } = await import("../../scripts/wallets-lib.mjs");
    for (const w of ALL_WALLETS) {
      const open = ((w.permissions as { allowsOpen?: string[] }).allowsOpen ?? []) as string[];
      expect(
        open.filter((t) => isLocalTarget(t)),
        w.id,
      ).toEqual([]);
    }
  });

  it("recognises local addresses, and leaves app links and public sites alone", async () => {
    const { isLocalTarget, withoutLocalOrigins } = await import("../../scripts/wallets-lib.mjs");
    for (const local of [
      "http://localhost:3000",
      "http://intearwallet.localhost:3000",
      "https://intearwallet.local",
      "http://127.0.0.1:8080",
      "http://[::1]:3000",
    ])
      expect(isLocalTarget(local), local).toBe(true);
    for (const ok of [
      "https://hot-labs.org/wallet",
      "hotwallet://",
      "intent://",
      "https://play.google.com",
    ])
      expect(isLocalTarget(ok), ok).toBe(false);
    expect(
      withoutLocalOrigins({
        allowsOpen: ["https://a.example", "http://localhost:1"],
        storage: true,
      }),
    ).toEqual({ allowsOpen: ["https://a.example"], storage: true });
  });
});
