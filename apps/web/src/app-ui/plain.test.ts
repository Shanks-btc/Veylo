// No raw code reaches a person (W7.3). The founder saw "Unavailable / needs_session" on the Fund
// screen. These tests keep every status, reason and flag the API or 1Click can send behind plain
// words, and fail when a screen starts printing one as it is.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BalanceStatsView, valueWhenUnavailable } from "./balance-stats";
import { RunTag, StateTag } from "./format";
import {
  ATTEMPT_STATUS,
  FUNDING_STATUS,
  PAYABLE_REASON,
  RECORD_STATUS,
  REVIEW_FLAG,
  UNAVAILABLE,
  attemptStatus,
  fundingStatus,
  payableReason,
  recordStatus,
  reviewFlag,
  whyUnavailable,
  wordsFromCode,
} from "./plain";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const src = join(root, "apps", "web", "src");
const read = (path: string) => readFileSync(path, "utf8");

/** Text with the tags removed. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
/** snake_case or SCREAMING_SNAKE: a code, not a word. */
const RAW_CODE = /\b[a-z]{2,}(?:_[a-z]{2,})+\b|\b[A-Z]{2,}(?:_[A-Z]{2,})+\b/;

const everyValue = (table: Readonly<Record<string, string>>) => Object.values(table);

describe("the tables cover every code the system can send", () => {
  it("every reason a contractor's address can't be paid", () => {
    const type = /export type PayableReason =([\s\S]*?);/.exec(
      read(join(root, "packages", "core", "src", "payee.ts")),
    )?.[1];
    const codes = [...(type ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(codes.length).toBeGreaterThan(8);
    for (const code of [...codes, "no_active_destination"])
      expect(PAYABLE_REASON[code], code).toBeTruthy();
  });

  it("every pay-run check", () => {
    const codes = [
      ...read(join(root, "packages", "core", "src", "review.ts")).matchAll(/code: "([a-z_]+)"/g),
    ].map((m) => m[1] as string);
    expect(new Set(codes).size).toBeGreaterThan(5);
    for (const code of codes) expect(REVIEW_FLAG[code], code).toBeTruthy();
  });

  it("every state of a payout attempt", () => {
    const format = read(join(src, "app-ui", "format.tsx"));
    const keys = [
      ...(/ATTEMPT_TONES[^{]*\{([\s\S]*?)\};/.exec(format)?.[1] ?? "").matchAll(/([A-Z]+):/g),
    ].map((m) => m[1] as string);
    expect(keys.length).toBeGreaterThan(7);
    for (const key of keys) expect(ATTEMPT_STATUS[key], key).toBeTruthy();
  });

  it("every status 1Click documents for a swap, and the one a funding event starts with", () => {
    // https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request
    for (const s of [
      "PENDING_DEPOSIT",
      "KNOWN_DEPOSIT_TX",
      "PROCESSING",
      "SUCCESS",
      "INCOMPLETE_DEPOSIT",
      "REFUNDED",
      "FAILED",
    ])
      expect(FUNDING_STATUS[s], s).toBeTruthy();
  });

  it("every reason a balance can't be shown", () => {
    for (const r of ["needs_session", "oneclick_error", "rpc_error"])
      expect(UNAVAILABLE[r], r).toBeTruthy();
  });
});

describe("the words themselves", () => {
  it("none is a code: no underscore and no SCREAMING word", () => {
    const all = [
      ...everyValue(UNAVAILABLE),
      ...everyValue(FUNDING_STATUS),
      ...everyValue(ATTEMPT_STATUS),
      ...everyValue(PAYABLE_REASON),
      ...everyValue(REVIEW_FLAG),
      ...everyValue(RECORD_STATUS),
    ];
    for (const words of all) {
      expect(words, words).not.toMatch(RAW_CODE);
      expect(words, words).not.toMatch(/_/);
      expect(words, words).not.toMatch(/\b[A-Z]{5,}\b/);
    }
  });

  it("a code nobody has written words for still becomes words", () => {
    expect(wordsFromCode("some_new_code")).toBe("Some new code");
    expect(wordsFromCode("SOME_NEW_CODE")).toBe("Some new code");
    expect(wordsFromCode("PartiallyCompleted")).toBe("Partially completed");
    expect(fundingStatus("A_BRAND_NEW_STATE")).toBe("A brand new state");
    expect(attemptStatus("WHATEVER_NEXT")).toBe("Whatever next");
    expect(payableReason("never_seen_reason")).toBe("Never seen reason");
    expect(recordStatus("new_state")).toBe("New state");
    expect(whyUnavailable("a_new_reason")).not.toMatch(/_/);
    expect(wordsFromCode("")).toBe("Unknown");
  });

  it("a payee check that carries the registry's reason says that reason in words", () => {
    expect(reviewFlag({ code: "destination_not_payable", detail: "destination_not_active" })).toBe(
      "Address not active yet",
    );
    expect(reviewFlag({ code: "address_recently_changed", detail: "changed 2026-11-13" })).toBe(
      "The address was changed recently: changed 2026-11-13",
    );
    expect(reviewFlag({ code: "contractor_archived" })).toBe("This contractor is archived");
  });
});

describe("what a screen shows", () => {
  const view = (reason: string, isOwner = true) =>
    renderToStaticMarkup(
      createElement(BalanceStatsView, {
        confidential: { available: false, unavailable: reason },
        pub: { available: false, unavailable: "rpc_error" },
        connect: createElement("button", { type: "button" }, "Connect your wallet"),
        isOwner,
      }),
    );

  it("a private balance that needs the wallet says so, with the button that does it", () => {
    const html = view("needs_session");
    const words = text(html);
    expect(words).toContain("Connect your wallet to see your private balance");
    expect(html).toContain("<button");
    expect(words).toContain("Connect your wallet");
    // The private balance's big number is "Not shown yet", not "Unavailable / needs_session".
    expect(words).toContain("Private balance Not shown yet");
    expect(words).not.toMatch(RAW_CODE);
    expect(words).not.toContain("needs_session");
  });

  it("only an owner is offered the button", () => {
    const html = view("needs_session", false);
    expect(html).not.toContain("<button");
    expect(text(html)).toContain("Only the owner of the treasury can connect to see this");
  });

  it("every other reason, known or not, is a sentence with no code in it", () => {
    for (const reason of ["oneclick_error", "rpc_error", "some_new_reason", ""]) {
      const words = text(view(reason));
      expect(words, reason).not.toMatch(RAW_CODE);
      expect(words, reason).not.toContain(reason || "\u0000");
    }
    expect(valueWhenUnavailable("rpc_error")).toBe("Unavailable");
    expect(valueWhenUnavailable("needs_session")).toBe("Not shown yet");
  });

  it("a payout state and a pay-run state are words, not codes", () => {
    for (const s of Object.keys(ATTEMPT_STATUS)) {
      const words = text(renderToStaticMarkup(createElement(StateTag, { status: s })));
      expect(words).toBe(ATTEMPT_STATUS[s]);
      expect(words).not.toMatch(/^[A-Z]{4,}$/);
    }
    for (const s of ["Draft", "InReview", "PartiallyCompleted", "Completed"]) {
      expect(text(renderToStaticMarkup(createElement(RunTag, { status: s })))).not.toMatch(
        /[a-z][A-Z]/,
      );
    }
  });
});

describe("no screen prints a code as it is (guard)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  const screens = ["screens", "app-ui", "ui"]
    .flatMap((d) => files(join(src, d)))
    .filter((f) => f.endsWith(".tsx") && !/\.test\./.test(f));
  const rel = (f: string) => relative(src, f).replaceAll("\\", "/");

  it("finds the screens it is meant to guard", () => {
    expect(screens.length).toBeGreaterThan(30);
    expect(screens.map(rel)).toContain("screens/fund.tsx");
  });

  it("nobody turns a code into words by hand (that is plain.ts's job)", () => {
    const hits = screens
      .filter((f) => /\.replaceAll\(\s*["']_["']|\.replace\(\s*\/_\/g/.test(read(f)))
      .map(rel);
    expect(hits).toEqual([]);
  });

  it("no JSX prints a status, a payable reason or an 'unavailable' reason as it comes", () => {
    const hits: string[] = [];
    for (const f of screens) {
      for (const m of read(f).matchAll(
        />\s*\{\s*[\w.?]+\.(?:status|payableReason|unavailable)\s*\}/g,
      ))
        hits.push(`${rel(f)}: ${m[0].replace(/\s+/g, " ")}`);
    }
    expect(hits).toEqual([]);
  });

  it("no JSX prints a snake_case or SCREAMING_SNAKE string literal", () => {
    // The one allowed exception: the CSV column names a person has to type into their own file.
    const CSV_COLUMNS = "name, email, route, near_account";
    const hits: string[] = [];
    for (const f of screens) {
      for (const m of read(f).matchAll(
        />\s*([^<>{}\n]*\b(?:[a-z]{2,}_[a-z]{2,}|[A-Z]{2,}_[A-Z]{2,})\b[^<>{}\n]*)</g,
      ))
        if ((m[1] ?? "").trim() !== CSV_COLUMNS || rel(f) !== "screens/import.tsx")
          hits.push(`${rel(f)}: ${(m[1] ?? "").trim()}`);
    }
    expect(hits).toEqual([]);
  });

  it("the fund screen shows funding progress and balances through plain.ts", () => {
    const fund = read(join(src, "screens", "fund.tsx"));
    expect(fund).toContain("fundingStatus(status)");
    expect(fund).toContain("BalanceStatsView");
    expect(fund).not.toMatch(/\.unavailable/);
    expect(read(join(src, "screens", "treasury.tsx"))).toContain("BalanceStatsView");
  });
});
