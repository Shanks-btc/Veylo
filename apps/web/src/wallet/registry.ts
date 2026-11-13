// Every NEAR wallet Veylo can offer (slice W6, part 2), read from the committed lock
// (wallets.lock.json, written by scripts/wallets-refresh.mjs from the near-connect manifest) and
// the hand review next to it. A wallet is enabled only if its manifest entry declares signMessage,
// its executor code handles it with our NEP-413 fields, it needs no hardware or relay permission,
// and every host it names is reviewed. Executors are served from the bridge origin under a name
// carrying their SHA-256; a test recomputes each hash.
import lock from "./wallets.lock.json";

export type WalletKind =
  "app" | "web" | "extension" | "hardware" | "multisig" | "relay" | "evm" | "developer" | "unknown";

export type WalletHost = {
  origin: string;
  count: number;
  line: number;
  col: number;
  context: string;
  verdict: "connect" | "img" | "frame" | "ignored" | "unreviewed";
  note: string;
};

export type WalletEntry = {
  id: string;
  name: string;
  description: string;
  website: string;
  version: string;
  kind: WalletKind;
  type: string;
  features: Record<string, boolean>;
  permissions: Record<string, unknown>;
  platform: { android?: string; ios?: string; web?: string; chrome?: string };
  /** A path on this app's origin, or "" when the wallet is excluded. */
  icon: string;
  iconSha256: string;
  executor: {
    source: string;
    sha256: string;
    bytes: number;
    file: string;
    upstreamSha256: string | null;
  };
  nep413: { signMessage: number; nonce: number; recipient: number };
  hosts: readonly WalletHost[];
  allow: { connect: readonly string[]; img: readonly string[]; frame: readonly string[] };
  enabled: boolean;
  reason: string;
};

type LockWallet = (typeof lock)["wallets"][number];

function entry(w: LockWallet): WalletEntry {
  const raw = w as unknown as {
    platform?: WalletEntry["platform"];
    executor: {
      source: string;
      sha256: string;
      bytes: number;
      file: string;
      upstream?: { sha256: string } | null;
    };
    icon: { sha256: string; file: string };
  };
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    website: w.website,
    version: w.version,
    kind: w.kind as WalletKind,
    type: (w as { type?: string }).type ?? "sandbox",
    features: w.features as unknown as Record<string, boolean>,
    permissions: w.permissions as unknown as Record<string, unknown>,
    platform: raw.platform ?? {},
    icon: raw.icon.file ? `/wallet-icons/${raw.icon.file}` : "",
    iconSha256: raw.icon.sha256,
    executor: {
      source: raw.executor.source,
      sha256: raw.executor.sha256,
      bytes: raw.executor.bytes,
      file: raw.executor.file,
      upstreamSha256: raw.executor.upstream?.sha256 ?? null,
    },
    nep413: w.nep413,
    hosts: w.hosts as readonly WalletHost[],
    allow: w.allow,
    enabled: w.enabled,
    reason: w.reason,
  };
}

export const MANIFEST_INFO = lock.manifest;
export const ALL_WALLETS: readonly WalletEntry[] = lock.wallets.map(entry);
export const ENABLED_WALLETS: readonly WalletEntry[] = ALL_WALLETS.filter((w) => w.enabled);

export const executorPath = (w: WalletEntry) => `/wallets/${w.executor.file}`;

export function walletById(id: string): WalletEntry | undefined {
  return ALL_WALLETS.find((w) => w.id === id);
}

/** Where the app frames each wallet: every wallet gets its own bridge page with its own CSP. */
export const bridgePath = (id: string) => `/w/${id}/`;
/** The Veylo wallet (the embedded one) has its own bridge page, with no network access at all. */
export const EMBEDDED_ID = "veylo-embedded";
export const EMBEDDED_PATH = "/embedded/";

const FIRST = ["hot-wallet", "meteor-wallet"] as const;

/**
 * The picker order: HOT and Meteor first, always. Then, on a phone, wallets with a mobile app or a
 * deep link ahead of browser extensions (which a phone browser can't run); on a computer, the
 * wallets that run in the browser ahead of phone-only apps.
 */
export function pickerOrder(
  wallets: readonly WalletEntry[],
  device: { mobile: boolean },
): WalletEntry[] {
  const rank = (w: WalletEntry): number => {
    const first = FIRST.indexOf(w.id as (typeof FIRST)[number]);
    if (first >= 0) return first;
    const hasApp = Boolean(w.platform.android || w.platform.ios);
    const runsInBrowser = w.kind === "web" || w.kind === "extension";
    if (device.mobile) return 10 + (hasApp ? 0 : 5) + (w.kind === "extension" ? 3 : 0);
    return 10 + (runsInBrowser ? 0 : 5);
  };
  return [...wallets].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** What kind of thing each wallet is, in plain words for the picker. */
export function kindLabel(w: WalletEntry): string {
  switch (w.kind) {
    case "app":
      return "Phone app";
    case "extension":
      return "Browser extension";
    case "web":
      return "Web wallet";
    default:
      return "Wallet";
  }
}

/** Official places to get a wallet: each enabled wallet's own website, from its manifest entry. */
export function getAWalletLinks(): { name: string; url: string }[] {
  return pickerOrder(ENABLED_WALLETS, { mobile: false })
    .filter((w) => /^https:\/\//.test(w.website))
    .map((w) => ({ name: w.name, url: w.website }));
}
