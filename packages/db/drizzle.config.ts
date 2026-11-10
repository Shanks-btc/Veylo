import { defineConfig } from "drizzle-kit";

// Used only to generate migration files, which needs no database connection.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
