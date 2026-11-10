import { sql } from "drizzle-orm";
import { pendingMigrations, readJournal } from "./migrate.js";
import type { Db } from "./repositories.js";

export type Readiness = { ready: true } | { ready: false; reason: string };

const rows = (result: unknown) =>
  ((result as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];

/** For GET /ready: the database answers, and every migration file has been applied. No secrets. */
export async function checkReadiness(db: Db): Promise<Readiness> {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return { ready: false, reason: "database_unreachable" };
  }
  try {
    const table = rows(
      await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations')::text as name`),
    );
    let last: bigint | null = null;
    if (table[0]?.name) {
      const max = rows(
        await db.execute(sql`select max(created_at)::text as at from drizzle.__drizzle_migrations`),
      );
      last = max[0]?.at ? BigInt(String(max[0].at)) : null;
    }
    const pending = pendingMigrations(readJournal(), last);
    return pending.length === 0
      ? { ready: true }
      : { ready: false, reason: `migrations_pending: ${pending.length}` };
  } catch {
    return { ready: false, reason: "migration_state_unreadable" };
  }
}
