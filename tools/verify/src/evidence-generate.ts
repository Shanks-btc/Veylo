// `pnpm evidence:generate`: writes docs/EVIDENCE.md from the database (Section 1) and the recorded
// Phase 2 transactions (Section 2). Deterministic: the same data always writes the same bytes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "@veylo/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { productEvidenceRows } from "./evidence-db.js";
import { renderEvidence } from "./evidence.js";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("Refusing to run: evidence:generate needs DATABASE_URL.");
  process.exit(1);
}
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const pool = new pg.Pool({ connectionString: url });
try {
  const rows = await productEvidenceRows(drizzle(pool, { schema }) as never);
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "EVIDENCE.md"), renderEvidence(rows));
  console.log(`Wrote docs/EVIDENCE.md: ${rows.length} product row(s), plus the Phase 2 rows.`);
} finally {
  await pool.end();
}
