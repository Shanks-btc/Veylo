// Workers refuse to start while migrations are pending or unreadable (L38). The same check /ready uses.
import { checkReadiness, type Db } from "@veylo/db";

type Log = { error: (o: object, m: string) => void };

/** True if the worker may start. Otherwise logs one line with the reason (never the URL). */
export async function migrationGuard(db: Db, log: Log, process: string): Promise<boolean> {
  const r = await checkReadiness(db);
  if (r.ready) return true;
  log.error({ reason: r.reason }, `${process} refusing to start: ${r.reason}`);
  return false;
}
