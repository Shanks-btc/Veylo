// "Approve payouts in wallet" stays disabled unless the gate module's report says every gate on every item passed.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fail, pass, type GateName, type GateReport } from "../gates/types";
import { canSign, checklist } from "../signing/pay-run";
import { SignPanel } from "./sign-panel";

const GATES: GateName[] = ["A", "deadline", "B", "B2", "C"];

function report(failing?: { item: number; gate: GateName }): GateReport {
  const items = [0, 1].map((n) => {
    const gates = GATES.map((g) =>
      failing && failing.item === n && failing.gate === g ? fail(g, "nope") : pass(g),
    );
    return { itemId: `item-${n}`, gates, passed: gates.every((g) => g.passed) };
  });
  return { items, allPassed: items.every((i) => i.passed) };
}

function signButton(props: Partial<Parameters<typeof SignPanel>[0]>): string {
  const html = renderToStaticMarkup(
    createElement(SignPanel, {
      report: undefined,
      checking: false,
      signing: false,
      msLeft: 600_000,
      count: 2,
      onCheck: () => {},
      onSign: () => {},
      ...props,
    }),
  );
  // The sign button is the one described by the signing note (its label changes while signing).
  const m = /<button[^>]*aria-describedby="sign-note"[^>]*>/.exec(html);
  if (!m) throw new Error("no approve button");
  return m[0];
}
const disabled = (b: string) => /\sdisabled=""/.test(b);

describe("Approve payouts in wallet", () => {
  it("is enabled when every gate passed on every item", () => {
    expect(disabled(signButton({ report: report() }))).toBe(false);
  });

  it("is disabled while the gates are pending (no report yet)", () => {
    expect(disabled(signButton({ report: undefined }))).toBe(true);
  });

  for (const gate of GATES) {
    it(`is disabled when gate ${gate} fails on one item`, () => {
      expect(disabled(signButton({ report: report({ item: 1, gate }) }))).toBe(true);
    });
  }

  it("is disabled for an empty report, while checking, while signing, and once expired", () => {
    expect(disabled(signButton({ report: { items: [], allPassed: false } }))).toBe(true);
    expect(disabled(signButton({ report: report(), checking: true }))).toBe(true);
    expect(disabled(signButton({ report: report(), signing: true }))).toBe(true);
    expect(disabled(signButton({ report: report(), msLeft: 0 }))).toBe(true);
  });

  it("is disabled while a warned payout hasn't been ticked, even when every gate passed (D5)", () => {
    expect(disabled(signButton({ report: report(), unacknowledged: 1 }))).toBe(true);
    expect(disabled(signButton({ report: report(), unacknowledged: 0 }))).toBe(false);
    expect(
      canSign({
        report: report(),
        checking: false,
        signing: false,
        expired: false,
        unacknowledged: 2,
      }),
    ).toBe(false);
  });

  it("canSign never overrides allPassed", () => {
    const r = report({ item: 0, gate: "C" });
    expect(canSign({ report: r, checking: false, signing: false, expired: false })).toBe(false);
  });
});

describe("checklist", () => {
  it("shows every gate as pending before checking", () => {
    expect(checklist(undefined).map((c) => c.state)).toEqual(Array(5).fill("pending"));
  });
  it("marks a failing gate FAIL with the item and reason", () => {
    const c = checklist(report({ item: 1, gate: "B2" }), new Map([["item-1", "Ada"]]));
    expect(c.find((x) => x.id === "B2")).toMatchObject({
      state: "fail",
      reason: expect.stringMatching(/^Ada: .*\(nope\)$/),
    });
    expect(c.filter((x) => x.state === "pass")).toHaveLength(4);
  });
});
