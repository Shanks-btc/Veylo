import { AppError } from "./errors.js";

const WINDOW_MS = 60 * 60 * 1000;

/**
 * Fixed one-hour windows on live-quote and signing-request routes (L32), per org and per user, for
 * each route separately. In memory, so limits are per API instance and reset on restart.
 */
export function createTreasuryLimiter(options: {
  clock: () => Date;
  perOrgPerHour: number;
  perUserPerHour: number;
}) {
  const windows = new Map<string, { startedAt: number; count: number }>();

  function over(key: string, max: number, now: number): boolean {
    const current = windows.get(key);
    if (!current || now - current.startedAt >= WINDOW_MS) return max < 1;
    return current.count >= max;
  }
  function count(key: string, now: number) {
    const current = windows.get(key);
    if (!current || now - current.startedAt >= WINDOW_MS)
      windows.set(key, { startedAt: now, count: 1 });
    else current.count += 1;
  }

  return {
    /** Throws 429 if either limit is reached. A refused attempt doesn't count. */
    check(route: string, orgId: string, userId: string) {
      const now = options.clock().getTime();
      const org = `org:${route}:${orgId}`;
      const user = `user:${route}:${userId}`;
      if (over(org, options.perOrgPerHour, now) || over(user, options.perUserPerHour, now)) {
        throw new AppError(429, "RATE_LIMITED", "Too many requests. Try again later");
      }
      count(org, now);
      count(user, now);
      if (windows.size > 10_000) {
        for (const [key, w] of windows) if (now - w.startedAt >= WINDOW_MS) windows.delete(key);
      }
    },
  };
}
