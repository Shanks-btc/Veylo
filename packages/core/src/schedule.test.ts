import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  isValidTimeZone,
  lastDayOfMonth,
  localDate,
  monthlyPayday,
  nextPayday,
  paydaysDue,
  periodOf,
  type Schedule,
} from "./schedule.js";

const at = (iso: string) => new Date(iso);
const monthly = (dayOfMonth: number, timeZone = "UTC"): Schedule => ({
  kind: "monthly",
  dayOfMonth,
  timeZone,
});

describe("month-end edges", () => {
  it("the 31st is the last day of a shorter month", () => {
    expect(monthlyPayday(2026, 4, 31)).toBe("2026-04-30"); // April has 30 days
    expect(monthlyPayday(2026, 6, 31)).toBe("2026-06-30");
    expect(monthlyPayday(2026, 12, 31)).toBe("2026-12-31");
  });
  it("February: 28 in 2026, 29 in the leap year 2028, and the 29th, 30th, 31st all clamp", () => {
    expect(lastDayOfMonth(2026, 2)).toBe(28);
    expect(lastDayOfMonth(2028, 2)).toBe(29);
    expect(lastDayOfMonth(2100, 2)).toBe(28); // 2100 isn't a leap year
    for (const d of [29, 30, 31]) expect(monthlyPayday(2026, 2, d)).toBe("2026-02-28");
    expect(monthlyPayday(2028, 2, 29)).toBe("2028-02-29");
    expect(monthlyPayday(2028, 2, 31)).toBe("2028-02-29");
  });
  it("refuses a day that isn't 1 to 31", () => {
    expect(() => monthlyPayday(2026, 1, 0)).toThrow(RangeError);
    expect(() => monthlyPayday(2026, 1, 32)).toThrow(RangeError);
  });
  it("a payday just after the month turns still belongs to its own month", () => {
    // Payday Mar 1, prepared Feb 26 (2026: February ends on the 28th).
    expect(paydaysDue(monthly(1), at("2026-02-26T12:00:00Z"))).toEqual(["2026-03-01"]);
    expect(paydaysDue(monthly(1), at("2026-02-25T12:00:00Z"))).toEqual([]);
  });
  it("the 31st payday of a 30-day month is prepared 3 days before the 30th", () => {
    expect(paydaysDue(monthly(31), at("2026-04-26T12:00:00Z"))).toEqual([]); // four days before
    expect(paydaysDue(monthly(31), at("2026-04-27T12:00:00Z"))).toEqual(["2026-04-30"]);
    expect(paydaysDue(monthly(31), at("2026-04-30T12:00:00Z"))).toEqual(["2026-04-30"]);
  });
});

describe("when a draft is due", () => {
  it("exactly three days before payday, not four", () => {
    expect(paydaysDue(monthly(15), at("2026-11-11T12:00:00Z"))).toEqual([]);
    expect(paydaysDue(monthly(15), at("2026-11-12T12:00:00Z"))).toEqual(["2026-11-15"]);
  });
  it("through payday itself, never after", () => {
    expect(paydaysDue(monthly(15), at("2026-11-15T23:59:00Z"))).toEqual(["2026-11-15"]);
    expect(paydaysDue(monthly(15), at("2026-11-16T00:01:00Z"))).toEqual([]);
  });
  it("biweekly: every 14 days from the anchor, including before the anchor", () => {
    const s: Schedule = { kind: "biweekly", anchorDate: "2026-11-13", timeZone: "UTC" };
    expect(paydaysDue(s, at("2026-11-10T00:00:00Z"))).toEqual(["2026-11-13"]);
    expect(paydaysDue(s, at("2026-11-24T00:00:00Z"))).toEqual(["2026-11-27"]);
    expect(paydaysDue(s, at("2026-10-27T00:00:00Z"))).toEqual(["2026-10-30"]); // before the anchor
    expect(paydaysDue(s, at("2026-10-31T00:00:00Z"))).toEqual([]); // that payday has passed
    expect(paydaysDue(s, at("2026-11-17T00:00:00Z"))).toEqual([]); // between paydays
    // A far-future anchor still works: paydays go back in steps of 14 days.
    const future: Schedule = { kind: "biweekly", anchorDate: "2027-06-04", timeZone: "UTC" };
    expect(paydaysDue(future, at("2026-11-17T00:00:00Z"))).toEqual(["2026-11-20"]);
  });
  it("two paydays in a month are two distinct drafts of the same period", () => {
    const s: Schedule = { kind: "biweekly", anchorDate: "2026-11-06", timeZone: "UTC" };
    const first = paydaysDue(s, at("2026-11-04T00:00:00Z"));
    const second = paydaysDue(s, at("2026-11-18T00:00:00Z"));
    expect([first, second]).toEqual([["2026-11-06"], ["2026-11-20"]]);
    expect(periodOf("2026-11-06")).toBe(periodOf("2026-11-20"));
  });
});

describe("time zones and daylight saving", () => {
  it("the date is the organisation's, not UTC's", () => {
    // 2026-11-29 12:30 UTC is already the 30th in Auckland (NZDT, UTC+13).
    expect(localDate(at("2026-11-29T12:30:00Z"), "Pacific/Auckland")).toBe("2026-11-30");
    expect(localDate(at("2026-11-29T12:30:00Z"), "UTC")).toBe("2026-11-29");
    expect(localDate(at("2026-11-29T12:30:00Z"), "America/Los_Angeles")).toBe("2026-11-29");
  });
  it("a draft is due on the organisation's preparation day, even when UTC hasn't reached it", () => {
    const s = monthly(3, "Pacific/Auckland"); // payday Dec 3, prepared Nov 30 (Auckland)
    expect(paydaysDue(s, at("2026-11-29T12:30:00Z"))).toEqual(["2026-12-03"]); // Nov 30 in Auckland
    expect(paydaysDue(monthly(3, "UTC"), at("2026-11-29T12:30:00Z"))).toEqual([]);
  });
  it("the days the clocks change don't move a payday or the preparation day", () => {
    // New York falls back on 2026-11-01 (a 25-hour day); Berlin falls back on 2026-10-25.
    const ny = monthly(4, "America/New_York"); // payday Nov 4, prepared Nov 1
    expect(paydaysDue(ny, at("2026-11-01T03:59:00Z"))).toEqual([]); // Oct 31 23:59 EDT
    expect(paydaysDue(ny, at("2026-11-01T04:01:00Z"))).toEqual(["2026-11-04"]); // Nov 1 00:01 EDT
    expect(paydaysDue(ny, at("2026-11-01T12:00:00Z"))).toEqual(["2026-11-04"]); // after the change
    const berlin = monthly(28, "Europe/Berlin"); // payday Oct 28, prepared Oct 25 (the change day)
    expect(paydaysDue(berlin, at("2026-10-24T21:59:00Z"))).toEqual([]);
    expect(paydaysDue(berlin, at("2026-10-24T22:01:00Z"))).toEqual(["2026-10-28"]);
    // Spring forward: New York 2026-03-08, payday Mar 11, prepared Mar 8.
    const spring = monthly(11, "America/New_York");
    expect(paydaysDue(spring, at("2026-03-08T04:59:00Z"))).toEqual([]);
    expect(paydaysDue(spring, at("2026-03-08T05:01:00Z"))).toEqual(["2026-03-11"]);
  });
  it("date arithmetic is calendar arithmetic across a clock change", () => {
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2026-03-08", -3)).toBe("2026-03-05");
    expect(daysBetween("2026-10-25", "2026-11-01")).toBe(7);
  });
  it("knows a real time zone from a made-up one", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("nextPayday", () => {
  it("is today when today is payday, and carries its preparation day", () => {
    expect(nextPayday(monthly(15), at("2026-11-15T10:00:00Z"))).toEqual({
      payday: "2026-11-15",
      prepareOn: "2026-11-12",
    });
  });
  it("rolls into the next month after payday", () => {
    expect(nextPayday(monthly(15), at("2026-11-16T10:00:00Z"))).toEqual({
      payday: "2026-12-15",
      prepareOn: "2026-12-12",
    });
    expect(nextPayday(monthly(31), at("2026-02-01T10:00:00Z")).payday).toBe("2026-02-28");
  });
});
