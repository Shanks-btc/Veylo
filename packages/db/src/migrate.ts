import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { migrationsFolder } from "./index.js";

type JournalEntry = { tag: string; when: number };

export function readJournal(folder = migrationsFolder): JournalEntry[] {
  const path = join(folder, "meta", "_journal.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { entries: JournalEntry[] }).entries;
}

/** Drizzle's own rule: a migration is pending if it's newer than the last one applied. */
export function pendingMigrations(
  entries: readonly JournalEntry[],
  lastAppliedAt: bigint | null,
): string[] {
  return entries
    .filter((e) => lastAppliedAt === null || BigInt(e.when) > lastAppliedAt)
    .map((e) => e.tag);
}

async function lastApplied(client: pg.Client): Promise<bigint | null> {
  const table = await client.query<{ name: string | null }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name`,
  );
  if (!table.rows[0]?.name) return null;
  const row = await client.query<{ at: string | null }>(
    `SELECT max(created_at)::text AS at FROM drizzle.__drizzle_migrations`,
  );
  return row.rows[0]?.at ? BigInt(row.rows[0].at) : null;
}

/** Applies pending migration files with Drizzle's migrator. Never a schema push. */
export async function applyMigrations(url: string, folder = migrationsFolder): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Two deploys starting together run one after the other. The number is arbitrary but fixed.
    await client.query("SELECT pg_advisory_lock(7265936)");
    const pending = pendingMigrations(readJournal(folder), await lastApplied(client));
    await migrate(drizzle(client), { migrationsFolder: folder });
    return pending;
  } finally {
    await client.end();
  }
}

/** `pnpm db:migrate`. Returns the exit code. Never prints the URL, which holds a password. */
export async function migrateCommand(
  env: Record<string, string | undefined>,
  log: (line: string) => void,
): Promise<number> {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    log("Refusing to run: DATABASE_URL is missing.");
    return 1;
  }
  if (!/^postgres(ql)?:\/\/\S+$/.test(url)) {
    log("Refusing to run: DATABASE_URL must be a postgres:// or postgresql:// URL.");
    return 1;
  }
  try {
    const applied = await applyMigrations(url);
    if (applied.length === 0) log("No pending migrations.");
    else {
      log(`Applied ${applied.length} migration(s):`);
      for (const tag of applied) log(`  ${tag}`);
    }
    return 0;
  } catch (err) {
    log(`Migration failed: ${err instanceof Error ? err.name : "unknown error"}`);
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") log(`Postgres code: ${code}`);
    return 1;
  }
}
