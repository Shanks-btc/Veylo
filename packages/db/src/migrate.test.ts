import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrateCommand, pendingMigrations, readJournal } from "./migrate.js";

describe("pendingMigrations", () => {
  const entries = [
    { tag: "a", when: 100 },
    { tag: "b", when: 200 },
  ];

  it("is everything on an empty database", () => {
    expect(pendingMigrations(entries, null)).toEqual(["a", "b"]);
  });

  it("is only what's newer than the last applied", () => {
    expect(pendingMigrations(entries, 100n)).toEqual(["b"]);
    expect(pendingMigrations(entries, 200n)).toEqual([]);
  });
});

describe("migrateCommand refuses", () => {
  const run = async (env: Record<string, string | undefined>) => {
    const lines: string[] = [];
    return { code: await migrateCommand(env, (l) => lines.push(l)), text: lines.join("\n") };
  };

  it.each([
    ["missing", {}],
    ["blank", { DATABASE_URL: "  " }],
  ])("a %s DATABASE_URL", async (_name, env) => {
    const { code, text } = await run(env);
    expect(code).toBe(1);
    expect(text).toContain("DATABASE_URL is missing");
  });

  it("a URL that isn't Postgres, without echoing it", async () => {
    const { code, text } = await run({ DATABASE_URL: "mysql://u:password-sentinel@h/d" });
    expect(code).toBe(1);
    expect(text).not.toContain("password-sentinel");
  });

  it("an unreachable server, without echoing the password", async () => {
    const { code, text } = await run({
      DATABASE_URL: "postgres://u:password-sentinel@127.0.0.1:1/d",
    });
    expect(code).toBe(1);
    expect(text).toContain("Migration failed");
    expect(text).not.toContain("password-sentinel");
  });
});

describe.runIf(process.env.VEYLO_TEST_PG)("migrateCommand on real Postgres", () => {
  it("applies every migration, says which, then finds none pending", async () => {
    const adminUrl = process.env.DATABASE_URL as string;
    const name = `veylo_migrate_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    try {
      const first: string[] = [];
      expect(await migrateCommand({ DATABASE_URL: url.href }, (l) => first.push(l))).toBe(0);
      const tags = readJournal().map((e) => e.tag);
      expect(first).toEqual([
        `Applied ${tags.length} migration(s):`,
        ...tags.map((tag) => `  ${tag}`),
      ]);
      const second: string[] = [];
      expect(await migrateCommand({ DATABASE_URL: url.href }, (l) => second.push(l))).toBe(0);
      expect(second).toEqual(["No pending migrations."]);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
});
