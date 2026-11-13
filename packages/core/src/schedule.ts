// Recurring payroll (slice W5, D1). Pure: dates in, dates out.
//
// A payday is a calendar date in the organisation's time zone, so every calculation here is on
// dates (YYYY-MM-DD), never on instants: a daylight-saving change can't move a payday or a
// preparation day. The only instant-to-date step is `localDate`, which asks the time zone what the
// date is right now.

export type Schedule =
  | { kind: "monthly"; dayOfMonth: number; timeZone: string }
  | { kind: "biweekly"; anchorDate: string; timeZone: string };

/** The draft is prepared this many days before payday. */
export const PREPARE_DAYS_BEFORE = 3;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return timeZone.length > 0;
  } catch {
    return false;
  }
}

function parts(date: string): { y: number; m: number; d: number } {
  const m = DATE.exec(date);
  if (!m) throw new RangeError(`not a date: ${date}`);
  return { y: digits(m[1] as string), m: digits(m[2] as string), d: digits(m[3] as string) };
}
/** A run of ASCII digits as an integer, with no floating-point parsing. */
function digits(text: string): number {
  let n = 0;
  for (const ch of text) n = n * 10 + (ch.charCodeAt(0) - 48);
  return n;
}
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const fromUtc = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const toUtc = (date: string) => {
  const { y, m, d } = parts(date);
  return Date.UTC(y, m - 1, d);
};
const DAY = 86_400_000;

export const addDays = (date: string, days: number): string => fromUtc(toUtc(date) + days * DAY);
export const daysBetween = (from: string, to: string): number =>
  Math.round((toUtc(to) - toUtc(from)) / DAY);

/** What the calendar date is, right now, in that time zone. */
export function localDate(now: Date, timeZone: string): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export const lastDayOfMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The day-of-month payday in that month; the 31st becomes the last day of a shorter month. */
export function monthlyPayday(year: number, month: number, dayOfMonth: number): string {
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31)
    throw new RangeError("day of month must be 1 to 31");
  return `${pad(year, 4)}-${pad(month)}-${pad(Math.min(dayOfMonth, lastDayOfMonth(year, month)))}`;
}

/** Paydays close enough to `today` to matter: the previous, current and next ones or two. */
function nearbyPaydays(schedule: Schedule, today: string): string[] {
  if (schedule.kind === "monthly") {
    const { y, m } = parts(today);
    const out: string[] = [];
    for (let k = -1; k <= 2; k += 1) {
      const idx = y * 12 + (m - 1) + k;
      out.push(monthlyPayday(Math.floor(idx / 12), (idx % 12) + 1, schedule.dayOfMonth));
    }
    return out;
  }
  const n = Math.floor(daysBetween(schedule.anchorDate, today) / 14);
  return [-1, 0, 1, 2].map((k) => addDays(schedule.anchorDate, 14 * (n + k)));
}

/**
 * The paydays whose draft should exist now: preparation day (payday minus three) up to and
 * including payday. A payday that has passed is never prepared late.
 */
export function paydaysDue(schedule: Schedule, now: Date): string[] {
  const today = localDate(now, schedule.timeZone);
  return nearbyPaydays(schedule, today).filter(
    (p) => addDays(p, -PREPARE_DAYS_BEFORE) <= today && today <= p,
  );
}

/** The next payday on or after today, with the day its draft is prepared. */
export function nextPayday(schedule: Schedule, now: Date): { payday: string; prepareOn: string } {
  const today = localDate(now, schedule.timeZone);
  const payday = nearbyPaydays(schedule, today)
    .filter((p) => p >= today)
    .sort()[0] as string;
  return { payday, prepareOn: addDays(payday, -PREPARE_DAYS_BEFORE) };
}

/** The pay run's period label (YYYY-MM): the month the payday falls in. */
export const periodOf = (payday: string): string => payday.slice(0, 7);
