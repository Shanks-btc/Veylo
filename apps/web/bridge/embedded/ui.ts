// The Veylo wallet's screens (slice W6): plain DOM, no framework, no inline script or style (the
// page's CSP allows neither), nothing that loads from anywhere else. Each screen is a promise the
// flow awaits. Plain words, one thing per screen: the recovery phrase, then confirm it, then how to
// protect the wallet. The wallet is the person's alone, and the screens say so.
import { describeMessage } from "./describe";
import type { Prompt, Protection, Start } from "./flow";

type Child = string | Node | null | false | undefined;
type Attrs = Record<string, string | boolean | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const WARNING =
  "Only you hold this wallet's key. If you lose this device and your recovery phrase, Veylo can't recover it.";

export function createPrompt(root: HTMLElement): Prompt {
  const live = h("p", { class: "notice", role: "status", "aria-live": "polite" });

  function screen(...children: Child[]) {
    root.replaceChildren(h("div", { class: "card" }, ...children), live);
    const first = root.querySelector<HTMLElement>("input, button");
    first?.focus();
  }

  /** Renders a screen and resolves with whatever its handler passes to `done`. */
  function ask<T>(build: (done: (value: T) => void) => Child[]): Promise<T> {
    return new Promise<T>((resolve) => screen(...build(resolve)));
  }

  const button = (label: string, onClick: () => void, variant = "dark") => {
    const b = h("button", { type: "button", class: `btn btn-${variant}` }, label);
    b.addEventListener("click", onClick);
    return b;
  };

  function field(
    id: string,
    label: string,
    opts: { type?: string; hint?: string; autocomplete?: string } = {},
  ) {
    const input = h("input", {
      id,
      type: opts.type ?? "text",
      autocomplete: opts.autocomplete ?? "off",
      autocapitalize: "none",
      spellcheck: "false",
      "aria-describedby": opts.hint ? `${id}-hint` : undefined,
    });
    return {
      input,
      node: h(
        "div",
        { class: "field" },
        h("label", { for: id }, label),
        opts.hint ? h("span", { class: "hint", id: `${id}-hint` }, opts.hint) : null,
        input,
      ),
    };
  }

  return {
    start: ({ hasWallet }) =>
      ask<Start>((done) => [
        h("h1", {}, hasWallet ? "Your Veylo wallet" : "Create your Veylo wallet"),
        h(
          "p",
          {},
          "A wallet keeps the key that approves your payments. It stays on this device, protected by you.",
        ),
        h("p", { class: "warn" }, WARNING),
        hasWallet
          ? button("Use my wallet on this device", () => done("connect"))
          : button("Create my Veylo wallet", () => done("create")),
        button("Restore from my recovery phrase", () => done("restore"), "grey"),
        hasWallet ? button("Create another wallet", () => done("create"), "grey") : null,
      ]),

    chooseProtection: ({ passkeys }) =>
      ask<Protection>((done) => [
        h("h1", {}, "Protect your wallet"),
        h("p", {}, "Choose how you will unlock it each time you approve a payment."),
        passkeys
          ? button("Use a passkey (fingerprint, face or device PIN)", () => done("passkey"))
          : null,
        button("Use a wallet password", () => done("password"), passkeys ? "grey" : "dark"),
        h(
          "p",
          { class: "hint" },
          "A wallet password is only for this wallet and is kept only on this device. It is not your email password.",
        ),
      ]),

    newPassword: () =>
      ask<string>((done) => {
        const a = field("pw1", "Wallet password", {
          type: "password",
          hint: "At least 12 characters. Not your email password.",
          autocomplete: "new-password",
        });
        const b = field("pw2", "Type it again", { type: "password", autocomplete: "new-password" });
        const error = h("p", { class: "error", role: "alert" });
        const go = () => {
          if (a.input.value.length < 12)
            return void (error.textContent = "Use at least 12 characters.");
          if (a.input.value !== b.input.value)
            return void (error.textContent = "The two passwords don't match.");
          done(a.input.value);
        };
        return [
          h("h1", {}, "Choose a wallet password"),
          a.node,
          b.node,
          error,
          button("Protect my wallet", go),
        ];
      }),

    password: () =>
      ask<string>((done) => {
        const a = field("pw", "Wallet password", {
          type: "password",
          autocomplete: "current-password",
        });
        a.input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") done(a.input.value);
        });
        return [
          h("h1", {}, "Unlock your wallet"),
          a.node,
          button("Unlock", () => done(a.input.value)),
        ];
      }),

    showPhrase: (words) =>
      ask<void>((done) => [
        h("h1", {}, "Your recovery phrase"),
        h(
          "p",
          {},
          "Write these words on paper, in order, and keep them somewhere safe. They are the only way to get your wallet back.",
        ),
        h("p", { class: "warn" }, WARNING),
        h("ol", { class: "words" }, ...words.map((w) => h("li", {}, h("span", {}, w)))),
        h(
          "p",
          { class: "hint" },
          "Never type these words into a website, a chat or an email. Veylo will never ask for them.",
        ),
        button("I have written them down", () => done()),
      ]),

    confirmPhrase: (positions) =>
      ask<string[]>((done) => {
        const fields = positions.map((p) => field(`w${p}`, `Word number ${p}`));
        const go = () => done(fields.map((f) => f.input.value));
        return [
          h("h1", {}, "Check your recovery phrase"),
          h("p", {}, "Type these words from your paper copy, so we know you have it."),
          ...fields.map((f) => f.node),
          button("Confirm", go),
        ];
      }),

    phrase: () =>
      ask<string>((done) => {
        const area = h("textarea", {
          id: "phrase",
          rows: "4",
          autocomplete: "off",
          autocapitalize: "none",
          spellcheck: "false",
          "aria-label": "Recovery phrase",
        });
        return [
          h("h1", {}, "Restore your wallet"),
          h("p", {}, "Type your 12 or 24 recovery words, separated by spaces."),
          area,
          button("Restore", () => done(area.value)),
        ];
      }),

    approve: ({ accountId, recipient, message }) =>
      ask<boolean>((done) => {
        const d = describeMessage(message, recipient);
        return [
          h("h1", {}, d.title),
          ...d.lines.map((l) => h("p", {}, l)),
          h(
            "details",
            {},
            h("summary", {}, "Show exactly what you are signing"),
            h("pre", { class: "raw" }, message),
            h(
              "p",
              { class: "hint" },
              `For ${recipient}, as ${accountId.slice(0, 8)}…${accountId.slice(-6)}`,
            ),
          ),
          button("Approve", () => done(true)),
          button("Cancel", () => done(false), "grey"),
        ];
      }),

    notice(text) {
      live.textContent = text;
    },

    finished() {
      root.replaceChildren(
        h("div", { class: "card" }, h("p", {}, "Done. You can go back to Veylo."), live),
      );
    },
  };
}
