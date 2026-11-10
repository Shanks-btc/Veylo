// `pnpm db:migrate` (dist/bin/migrate.js). Its config comes from the config package like every other
// process: DATABASE_URL only (L38, L39). A ConfigError names the variable, never its value.
import { ConfigError, loadMigrationConfig } from "@veylo/config";
import { migrateCommand } from "./migrate.js";

const log = (line: string) => console.log(line);

let databaseUrl: string;
try {
  databaseUrl = loadMigrationConfig(process.env).DATABASE_URL;
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  log(err.message);
  process.exit(1);
}
process.exitCode = await migrateCommand({ DATABASE_URL: databaseUrl }, log);
