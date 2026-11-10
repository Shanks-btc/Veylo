import { fileURLToPath } from "node:url";

export * as schema from "./schema.js";

/** Absolute path of the migration files, for whichever driver applies them. */
export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
export * from "./repositories.js";
export { checkReadiness, type Readiness } from "./readiness.js";
