// The Veylo wallet's behaviour (slice W6): make a wallet, restore one from its recovery phrase,
// sign what the app sends, show the phrase again. All the talking to the person goes through the
// `Prompt` (the page's screens, or a script in tests), and everything else is injected, so the whole
// flow runs in tests. The rules it keeps:
//   - The key is made here, from the browser's random source, and stored only as an encrypted vault.
//   - A new wallet isn't stored, and so isn't usable, until the person has re-entered chosen words
//     of the recovery phrase correctly.
//   - A signature is made only after the person approves the exact message on screen and unlocks the
//     wallet with the passkey or the wallet password. The app verifies every signature itself.
//   - Nothing here can send anything anywhere: this file and its imports have no network access (a
//     test reads the source), and the page's CSP says connect-src 'none'.
import { ed25519 } from "@noble/curves/ed25519.js";
import { base64, base64url } from "@scure/base";
import { hashNep413 } from "@veylo/intents";
import type { WalletSigner } from "../../src/wallet/types";
import {
  entropyFromPhrase,
  keyFromEntropy,
  keyFromPhrase,
  newPhrase,
  phraseFromEntropy,
  splitPhrase,
} from "./derive";
import type { VaultStore } from "./store";
import { PrfUnsupported, type Passkeys } from "./webauthn";
import {
  newVault,
  unlockWithPasskey,
  unlockWithPassword,
  wrapWithPasskey,
  wrapWithPassword,
  type VaultBlob,
  type Wrap,
} from "./vault";

export type Start = "create" | "restore" | "connect";
export type Protection = "passkey" | "password";

export type Prompt = {
  /** The first screen. `hasWallet`: this browser already holds a wallet. */
  start(state: { hasWallet: boolean }): Promise<Start>;
  chooseProtection(state: { passkeys: boolean }): Promise<Protection>;
  /** Asks twice and checks length before it resolves. */
  newPassword(): Promise<string>;
  password(accountId: string): Promise<string>;
  /** Shows the words once; resolves when the person says they wrote them down. */
  showPhrase(words: readonly string[]): Promise<void>;
  /** Asks for the words at these 1-based positions. */
  confirmPhrase(positions: readonly number[]): Promise<string[]>;
  phrase(): Promise<string>;
  /** Shows what is about to be signed. Resolves false if the person declines. */
  approve(request: { accountId: string; recipient: string; message: string }): Promise<boolean>;
  notice(text: string): void;
  /** The wallet is ready (or the request is over): the page can hide itself. */
  finished(): void;
};

export class PhraseNotConfirmed extends Error {
  constructor() {
    super("The wallet was not created: the recovery phrase wasn't confirmed.");
    this.name = "PhraseNotConfirmed";
  }
}

export type FlowDeps = {
  store: VaultStore;
  passkeys: Passkeys;
  prompt: Prompt;
  random: (bytes: number) => Uint8Array;
  /** The relying party for passkeys: this page's host. */
  rpId: string;
  now?: () => number;
  /** How many wrong confirmations are allowed before the creation is abandoned. */
  maxConfirmAttempts?: number;
};

/** How long an unlocked wallet password stays good for repeated approvals (passkeys never cache). */
export const PASSWORD_CACHE_MS = 5 * 60_000;

/** Distinct positions (1-based), in order. 3 of 12 words, 4 of 24. */
export function pickPositions(total: number, random: (n: number) => Uint8Array): number[] {
  const count = total >= 24 ? 4 : 3;
  const chosen = new Set<number>();
  const bytes = random(64);
  for (let i = 0; chosen.size < count && i < bytes.length; i += 1) {
    chosen.add(((bytes[i] ?? 0) % total) + 1);
  }
  // 64 random bytes always give enough distinct positions; this is only for a broken random source.
  for (let p = 1; chosen.size < count && p <= total; p += 1) chosen.add(p);
  return [...chosen].sort((a, b) => a - b);
}

export function createEmbeddedWallet(deps: FlowDeps): WalletSigner & {
  manage(action: "export" | "addPasskey"): Promise<{ accountId: string }>;
} {
  const { store, passkeys, prompt, random } = deps;
  const now = deps.now ?? (() => Date.now());
  let connected: { accountId: string; publicKey: string } | undefined;
  let cached: { entropy: Uint8Array; until: number } | undefined;

  async function makePasskeyWrap(entropy: Uint8Array): Promise<Wrap> {
    const prfSalt = random(32);
    const { accountId } = keyFromEntropy(entropy);
    const made = await passkeys.create({
      rpId: deps.rpId,
      userId: random(16),
      userName: `Veylo wallet ${accountId.slice(0, 8)}`,
      prfSalt,
      random,
    });
    return wrapWithPasskey(
      entropy,
      made.prfOutput,
      { credentialId: made.credentialId, prfSalt: base64.encode(prfSalt), rpId: deps.rpId },
      random,
    );
  }

  /** Protects with the chosen method; where PRF is missing it says so and uses a password. */
  async function protect(entropy: Uint8Array): Promise<Wrap> {
    const choice = await prompt.chooseProtection({ passkeys: true });
    if (choice === "passkey") {
      try {
        return await makePasskeyWrap(entropy);
      } catch (err) {
        // Anything that stops a passkey (no PRF, a cancelled prompt, a blocked or invalid domain)
        // falls back to a password: never a dead end, and never a wallet without protection.
        prompt.notice(
          err instanceof PrfUnsupported
            ? "This device can't use a passkey for a wallet. Use a wallet password instead."
            : "A passkey couldn't be set up here. Use a wallet password instead.",
        );
      }
    }
    return wrapWithPassword(entropy, await prompt.newPassword(), random);
  }

  async function unlock(blob: VaultBlob): Promise<Uint8Array> {
    if (cached && cached.until > now()) return cached.entropy;
    cached = undefined;
    const passkeyWrap = blob.wraps.find((w) => w.kind === "passkey");
    if (passkeyWrap && passkeyWrap.kind === "passkey") {
      try {
        const out = await passkeys.get({
          rpId: passkeyWrap.rpId,
          credentialId: passkeyWrap.credentialId,
          prfSalt: base64.decode(passkeyWrap.prfSalt),
          random,
        });
        return await unlockWithPasskey(blob, passkeyWrap, out);
      } catch (err) {
        // With a password as well, fall back to it; otherwise the passkey was the only way in.
        if (!blob.wraps.some((w) => w.kind === "password")) throw err;
      }
    }
    const passwordWrap = blob.wraps.find((w) => w.kind === "password");
    if (!passwordWrap || passwordWrap.kind !== "password")
      throw new Error("This wallet can't be unlocked here.");
    const entropy = await unlockWithPassword(
      blob,
      passwordWrap,
      await prompt.password(blob.accountId),
    );
    cached = { entropy, until: now() + PASSWORD_CACHE_MS };
    return entropy;
  }

  async function create(): Promise<{ accountId: string; publicKey: string }> {
    const phrase = newPhrase(12);
    const words = splitPhrase(phrase);
    const entropy = entropyFromPhrase(phrase);
    const key = keyFromPhrase(phrase);
    await prompt.showPhrase(words);
    const attempts = deps.maxConfirmAttempts ?? 5;
    let confirmed = false;
    for (let i = 0; i < attempts && !confirmed; i += 1) {
      const positions = pickPositions(words.length, random);
      const entered = await prompt.confirmPhrase(positions);
      confirmed = positions.every(
        (p, j) => (entered[j] ?? "").trim().toLowerCase() === words[p - 1],
      );
      if (!confirmed) {
        prompt.notice("Those words don't match. Look at your recovery phrase again.");
        await prompt.showPhrase(words);
      }
    }
    if (!confirmed) throw new PhraseNotConfirmed();
    // Only now is the wallet stored, and so usable.
    const wrap = await protect(entropy);
    await store.put(newVault(entropy, wrap));
    connected = { accountId: key.accountId, publicKey: key.publicKey };
    prompt.finished();
    return connected;
  }

  async function restore(): Promise<{ accountId: string; publicKey: string }> {
    const phrase = await prompt.phrase();
    const key = keyFromPhrase(phrase); // refuses a phrase that isn't valid
    const entropy = entropyFromPhrase(phrase);
    const wrap = await protect(entropy);
    await store.put(newVault(entropy, wrap));
    connected = { accountId: key.accountId, publicKey: key.publicKey };
    prompt.finished();
    return connected;
  }

  async function existing(): Promise<VaultBlob | undefined> {
    return (await store.list())[0];
  }

  return {
    async connect(intent) {
      const blob = await existing();
      const choice: Start = intent ?? (await prompt.start({ hasWallet: blob !== undefined }));
      if (choice === "create") return create();
      if (choice === "restore") return restore();
      if (!blob) return create();
      connected = { accountId: blob.accountId, publicKey: blob.publicKey };
      prompt.finished();
      return connected;
    },

    async signMessage({ message, recipient, nonce }) {
      if (!connected) throw new Error("Connect the wallet first.");
      const blob = (await store.list()).find((b) => b.accountId === connected?.accountId);
      if (!blob) throw new Error("This wallet isn't on this device.");
      const approved = await prompt.approve({ accountId: blob.accountId, recipient, message });
      if (!approved) throw new Error("You declined to sign.");
      const entropy = await unlock(blob);
      const key = keyFromEntropy(entropy);
      const signature = ed25519.sign(hashNep413({ message, recipient, nonce }), key.secret);
      prompt.finished();
      return {
        accountId: key.accountId,
        publicKey: key.publicKey,
        signature: base64.encode(signature),
      };
    },

    async manage(action) {
      if (!connected) throw new Error("Connect the wallet first.");
      const blob = (await store.list()).find((b) => b.accountId === connected?.accountId);
      if (!blob) throw new Error("This wallet isn't on this device.");
      const entropy = await unlock(blob);
      if (action === "export") {
        await prompt.showPhrase(splitPhrase(phraseFromEntropy(entropy)));
      } else {
        const wrap = await makePasskeyWrap(entropy);
        await store.put({ ...blob, wraps: [...blob.wraps, wrap] });
      }
      prompt.finished();
      return { accountId: blob.accountId };
    },

    async disconnect() {
      connected = undefined;
      cached = undefined;
    },
  };
}

/** A passkey credential id is base64url; this is the one place it is decoded for display or tests. */
export const credentialIdBytes = (id: string): Uint8Array => base64url.decode(id);
