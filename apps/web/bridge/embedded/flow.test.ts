// The Veylo wallet's flows (slice W6): creating needs the recovery phrase confirmed, a recovery
// phrase restores the same account, signing needs approval and unlocking, and what comes back passes
// the same app-side verification as any external wallet. Argon2id is made cheap here for speed; its
// real cost is checked in vault.test.ts.
import { createHmac, randomBytes } from "node:crypto";
import { base64, base64url } from "@scure/base";
import { verifyNep413 } from "@veylo/intents";
import { describe, expect, it, vi } from "vitest";
import { createBridgeHandler } from "../handler";
import { createBridgeWallet, type BridgeTransport } from "../../src/wallet/bridge-client";
import { BRIDGE_PROTOCOL } from "../../src/wallet/bridge-protocol";
import { keyFromPhrase } from "./derive";
import {
  PASSWORD_CACHE_MS,
  PhraseNotConfirmed,
  createEmbeddedWallet,
  pickPositions,
  type Prompt,
} from "./flow";
import { memoryStore } from "./store";
import { PrfUnsupported, type Passkeys } from "./webauthn";

// Argon2id at its real cost is covered in vault.test.ts; flows use a cheap one for speed.
vi.mock("./vault", async (original) => {
  const real = (await original()) as typeof import("./vault");
  return {
    ...real,
    wrapWithPassword: (e: Uint8Array, pw: string, r: (n: number) => Uint8Array) =>
      real.wrapWithPassword(e, pw, r, { t: 1, m: 8, p: 1 }),
  };
});

const random = (n: number) => new Uint8Array(randomBytes(n));
const RP = "wallet.veylo.test";
const NOW = { t: 1_000_000 };

/** A passkey authenticator with PRF: the output depends on the credential and the salt. */
function fakePasskeys(opts: { prf?: boolean; createFails?: Error } = {}) {
  const calls = { create: 0, get: 0 };
  const secrets = new Map<string, Buffer>();
  const prfFor = (id: string, salt: Uint8Array) =>
    new Uint8Array(
      createHmac("sha256", secrets.get(id) ?? Buffer.alloc(0))
        .update(salt)
        .digest(),
    );
  const passkeys: Passkeys = {
    async create({ prfSalt, random: r }) {
      calls.create += 1;
      if (opts.createFails) throw opts.createFails;
      if (opts.prf === false) throw new PrfUnsupported();
      const id = base64url.encode(r(16));
      secrets.set(id, Buffer.from(r(32)));
      return { credentialId: id, prfOutput: prfFor(id, prfSalt) };
    },
    async get({ credentialId, prfSalt }) {
      calls.get += 1;
      if (!secrets.has(credentialId)) throw new PrfUnsupported();
      return prfFor(credentialId, prfSalt);
    },
  };
  return { passkeys, calls };
}

type Script = {
  start?: "create" | "restore" | "connect";
  protection?: "passkey" | "password";
  password?: string;
  typedPassword?: string;
  approve?: boolean;
  phraseToRestore?: string;
  wrongConfirm?: boolean;
};

/** A person following a script, and a record of everything the screens were asked to show. */
function person(script: Script = {}) {
  const log = {
    shown: [] as string[][],
    notices: [] as string[],
    approvals: 0,
    passwordAsks: 0,
    finished: 0,
  };
  let phrase: string[] = [];
  const prompt: Prompt = {
    async start() {
      return script.start ?? "create";
    },
    async chooseProtection() {
      return script.protection ?? "password";
    },
    async newPassword() {
      return script.password ?? "a wallet password only i know";
    },
    async password() {
      log.passwordAsks += 1;
      return script.typedPassword ?? script.password ?? "a wallet password only i know";
    },
    async showPhrase(words) {
      phrase = [...words];
      log.shown.push([...words]);
    },
    async confirmPhrase(positions) {
      return positions.map((p) => (script.wrongConfirm ? "wrong" : (phrase[p - 1] ?? "")));
    },
    async phrase() {
      return script.phraseToRestore ?? "";
    },
    async approve() {
      log.approvals += 1;
      return script.approve ?? true;
    },
    notice(text) {
      log.notices.push(text);
    },
    finished() {
      log.finished += 1;
    },
  };
  return { prompt, log, phrase: () => phrase.join(" ") };
}

function make(
  script: Script = {},
  opts: { prf?: boolean; store?: ReturnType<typeof memoryStore>; createFails?: Error } = {},
) {
  const store = opts.store ?? memoryStore();
  const p = person(script);
  const pk = fakePasskeys({
    ...(opts.prf === undefined ? {} : { prf: opts.prf }),
    ...(opts.createFails ? { createFails: opts.createFails } : {}),
  });
  const wallet = createEmbeddedWallet({
    store,
    passkeys: pk.passkeys,
    prompt: p.prompt,
    random,
    rpId: RP,
    now: () => NOW.t,
  });
  return { wallet, store, ...p, ...pk };
}

const SIGN = {
  message: "Pay Ada 100 USDC",
  recipient: "veylo.test",
  nonce: new Uint8Array(32).fill(3),
};

describe("creating a wallet", () => {
  it("shows the phrase, asks for chosen words, and only then stores the wallet", async () => {
    const t = make();
    const account = await t.wallet.connect("create");
    expect(t.log.shown).toHaveLength(1);
    expect(t.log.shown[0]).toHaveLength(12);
    expect(account.accountId).toBe(keyFromPhrase(t.phrase()).accountId);
    expect(account.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(await t.store.list()).toHaveLength(1);
  });

  it("is not stored, and so not usable, if the phrase is not confirmed", async () => {
    const t = make({ wrongConfirm: true });
    await expect(t.wallet.connect("create")).rejects.toBeInstanceOf(PhraseNotConfirmed);
    expect(await t.store.list()).toHaveLength(0);
    expect(t.log.notices.length).toBeGreaterThan(0);
    await expect(t.wallet.signMessage(SIGN)).rejects.toThrow(/Connect/);
  });

  it("asks for 3 distinct words out of 12 (4 out of 24), in order", () => {
    for (let i = 0; i < 50; i += 1) {
      const a = pickPositions(12, random);
      expect(a).toHaveLength(3);
      expect(new Set(a).size).toBe(3);
      expect([...a].sort((x, y) => x - y)).toEqual(a);
      expect(a.every((p) => p >= 1 && p <= 12)).toBe(true);
    }
    expect(pickPositions(24, random)).toHaveLength(4);
  });

  it("stores only ciphertext", async () => {
    const t = make();
    await t.wallet.connect("create");
    const stored = JSON.stringify(await t.store.list());
    for (const word of t.phrase().split(" ")) expect(stored).not.toContain(`"${word}"`);
    expect(stored).not.toContain("a wallet password only i know");
  });

  it("falls back to a password, and says so, where the device can't do passkeys", async () => {
    const t = make({ protection: "passkey" }, { prf: false });
    await t.wallet.connect("create");
    expect(t.log.notices.join(" ")).toMatch(/passkey/);
    const [blob] = await t.store.list();
    expect(blob?.wraps.map((w) => w.kind)).toEqual(["password"]);
  });

  it("falls back to a password, never a dead end, when a passkey fails for any reason (cancelled, invalid domain)", async () => {
    for (const failure of [
      new Error("This is an invalid domain."),
      new DOMException("The operation was cancelled", "NotAllowedError"),
    ]) {
      const t = make({ protection: "passkey" }, { createFails: failure });
      const account = await t.wallet.connect("create");
      expect(account.accountId).toBe(keyFromPhrase(t.phrase()).accountId);
      expect(t.log.notices.join(" ")).toMatch(/passkey couldn't be set up/);
      const [blob] = await t.store.list();
      expect(blob?.wraps.map((w) => w.kind)).toEqual(["password"]);
    }
  });
});

describe("the recovery phrase restores the same account and key", () => {
  it("restores on a fresh device and signs with the same public key", async () => {
    const first = make();
    const created = await first.wallet.connect("create");
    const phrase = first.phrase();
    const second = make({ phraseToRestore: phrase });
    const restored = await second.wallet.connect("restore");
    expect(restored).toEqual(created);
    const sig = await second.wallet.signMessage(SIGN);
    expect(sig.publicKey).toBe(created.publicKey);
  });

  it("refuses a phrase that isn't valid", async () => {
    const t = make({ phraseToRestore: "these words are not a recovery phrase" });
    await expect(t.wallet.connect("restore")).rejects.toThrow(/valid recovery phrase/);
    expect(await t.store.list()).toHaveLength(0);
  });
});

describe("signing", () => {
  it("needs approval of the exact message, then unlocks, and the signature verifies", async () => {
    const t = make();
    const account = await t.wallet.connect("create");
    const s = await t.wallet.signMessage(SIGN);
    expect(t.log.approvals).toBe(1);
    expect(s.accountId).toBe(account.accountId);
    expect(verifyNep413({ ...SIGN, publicKey: s.publicKey, signature: s.signature })).toBe(true);
  });

  it("declining signs nothing", async () => {
    const t = make({ approve: false });
    await t.wallet.connect("create");
    await expect(t.wallet.signMessage(SIGN)).rejects.toThrow(/declined/);
  });

  it("a wrong wallet password signs nothing", async () => {
    const t = make({ typedPassword: "not the password" });
    await t.wallet.connect("create");
    await expect(t.wallet.signMessage(SIGN)).rejects.toThrow(/did not unlock/);
  });

  it("asks for the password once per five minutes, then again", async () => {
    const t = make();
    await t.wallet.connect("create");
    await t.wallet.signMessage(SIGN);
    await t.wallet.signMessage(SIGN);
    expect(t.log.passwordAsks).toBe(1);
    NOW.t += PASSWORD_CACHE_MS + 1;
    await t.wallet.signMessage(SIGN);
    expect(t.log.passwordAsks).toBe(2);
  });

  it("a passkey wallet needs the passkey for every signature", async () => {
    const t = make({ protection: "passkey" });
    await t.wallet.connect("create");
    expect(t.calls.create).toBe(1);
    await t.wallet.signMessage(SIGN);
    await t.wallet.signMessage(SIGN);
    expect(t.calls.get).toBe(2);
    expect(t.log.passwordAsks).toBe(0);
  });

  it("a tampered stored blob can't sign", async () => {
    const t = make();
    await t.wallet.connect("create");
    const [blob] = await t.store.list();
    const wrap = blob!.wraps[0]!;
    const bytes = base64.decode(wrap.ct);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await t.store.put({ ...blob!, wraps: [{ ...wrap, ct: base64.encode(bytes) }] });
    NOW.t += PASSWORD_CACHE_MS + 1;
    await expect(t.wallet.signMessage(SIGN)).rejects.toThrow(/did not unlock/);
  });

  it("disconnecting forgets the unlocked wallet", async () => {
    const t = make();
    await t.wallet.connect("create");
    await t.wallet.signMessage(SIGN);
    await t.wallet.disconnect();
    await expect(t.wallet.signMessage(SIGN)).rejects.toThrow(/Connect/);
  });
});

describe("backup and a second passkey", () => {
  it("shows the same recovery phrase again after unlocking", async () => {
    const t = make();
    await t.wallet.connect("create");
    const original = t.phrase();
    t.log.shown.length = 0;
    await t.wallet.manage("export");
    expect(t.log.shown[0]?.join(" ")).toBe(original);
  });

  it("adds a passkey, and either way in then works", async () => {
    const t = make();
    await t.wallet.connect("create");
    await t.wallet.manage("addPasskey");
    const [blob] = await t.store.list();
    expect(blob?.wraps.map((w) => w.kind)).toEqual(["password", "passkey"]);
    NOW.t += PASSWORD_CACHE_MS + 1;
    // The passkey comes first when present.
    await t.wallet.signMessage(SIGN);
    expect(t.calls.get).toBeGreaterThan(0);
  });
});

describe("a signature from the Veylo wallet passes the same app-side verification as any wallet", () => {
  const APP = "https://app.veylo.test";
  const BRIDGE = "https://wallet.veylo.test";

  function loopback() {
    const t = make();
    const frame = {};
    const listeners: ((e: { origin: string; source: unknown; data: unknown }) => void)[] = [];
    const parent = {
      postMessage: (message: unknown) =>
        queueMicrotask(() =>
          listeners.forEach((l) => l({ origin: BRIDGE, source: frame, data: message })),
        ),
    };
    const onMessage = createBridgeHandler({ appOrigin: APP, parent, wallet: async () => t.wallet });
    const transport: BridgeTransport = {
      post: (message) => void onMessage({ origin: APP, source: parent, data: message }),
      listen: (h) => {
        listeners.push(h);
        return () => {};
      },
      frameWindow: () => frame,
      show: () => {},
    };
    const wallet = createBridgeWallet({
      bridgeOrigin: BRIDGE,
      transport,
      rpc: { isAccountKey: async () => false },
      // Making a wallet runs Argon2id (about two seconds on a slow machine); that is not a hang.
      timeoutMs: 30_000,
    });
    listeners.forEach((l) =>
      l({ origin: BRIDGE, source: frame, data: { protocol: BRIDGE_PROTOCOL, ready: true } }),
    );
    return { wallet, t };
  }

  it("connects (an implicit account owns its own key) and signs over the exact bytes", async () => {
    const { wallet, t } = loopback();
    const account = await wallet.connect("create");
    expect(account.accountId).toBe(keyFromPhrase(t.phrase()).accountId);
    const s = await wallet.signMessage(SIGN);
    expect(verifyNep413({ ...SIGN, publicKey: s.publicKey, signature: s.signature })).toBe(true);
  });

  it("the app refuses it if it signs other bytes", async () => {
    const { wallet } = loopback();
    await wallet.connect("create");
    // A different message than the one the wallet was asked to approve and sign.
    await expect(
      wallet.signMessage({ ...SIGN, message: "Pay Ada 100 USDC" }).then(async (s) => {
        if (
          !verifyNep413({
            ...SIGN,
            message: "Pay Mallory 100 USDC",
            publicKey: s.publicKey,
            signature: s.signature,
          })
        )
          throw new Error("the signature doesn't verify");
        return s;
      }),
    ).rejects.toThrow(/doesn't verify/);
  });
});

describe("the wallet never touches the network", () => {
  it("makes, restores, signs and backs up without a single request of any kind", async () => {
    const calls: string[] = [];
    const record = (name: string) => () => {
      calls.push(name);
      throw new Error(`no network: ${name}`);
    };
    vi.stubGlobal("fetch", record("fetch"));
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        constructor() {
          record("XMLHttpRequest")();
        }
      },
    );
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          record("WebSocket")();
        }
      },
    );
    vi.stubGlobal(
      "EventSource",
      class {
        constructor() {
          record("EventSource")();
        }
      },
    );
    vi.stubGlobal("navigator", { sendBeacon: record("sendBeacon") });
    try {
      const a = make({ protection: "passkey" });
      await a.wallet.connect("create");
      await a.wallet.signMessage(SIGN);
      await a.wallet.manage("export");
      await a.wallet.manage("addPasskey");
      const b = make({ phraseToRestore: a.phrase() });
      await b.wallet.connect("restore");
      await b.wallet.signMessage(SIGN);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toEqual([]);
  });
});
