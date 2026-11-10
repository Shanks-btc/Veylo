// Helpers for verification scripts only. Nothing outside verification/ may import this.
// Implements the redaction policy in VERIFICATION.md section 0, rule 3.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

config({ path: fileURLToPath(new URL("./.env", import.meta.url)), quiet: true });

const REDACTED = "[REDACTED]";
const NAMED_SECRET_VARS = ["ONECLICK_JWT", "NEARAI_API_KEY", "X402_FACILITATOR_API_KEY"];
const SECRET_KEY_NAMES = new Set([
  "authorization",
  "x-api-key",
  "secret_key",
  "private_key",
  "api_key",
  "jwt",
  "accesstoken",
  "refreshtoken",
]);

const runtimeSecrets = new Set<string>();

/** Registers a value returned at runtime (accessToken, refreshToken) for redaction by value. */
export function registerSecret(value: string | null | undefined): void {
  if (value?.trim()) runtimeSecrets.add(value);
}

// Read on every call so .env values and later registrations both apply. Each secret is
// also matched URL-encoded, since "ed25519:..." becomes "ed25519%3A..." in a query string.
// Longest first, so a secret that contains another is never partly replaced.
function secretPatterns(): string[] {
  const fromEnv = Object.entries(process.env)
    .filter(([name]) => name.endsWith("_SECRET_KEY") || NAMED_SECRET_VARS.includes(name))
    .map(([, value]) => value)
    .filter((value): value is string => Boolean(value?.trim()));
  const patterns = [...fromEnv, ...runtimeSecrets].flatMap((s) => [s, encodeURIComponent(s)]);
  return [...new Set(patterns)].sort((a, b) => b.length - a.length);
}

function scrub(text: string, patterns: string[]): string {
  return patterns.reduce((out, secret) => out.split(secret).join(REDACTED), text);
}

function walk(value: unknown, patterns: string[]): unknown {
  if (typeof value === "string") return scrub(value, patterns);
  if (Array.isArray(value)) return value.map((item) => walk(item, patterns));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        scrub(k, patterns),
        SECRET_KEY_NAMES.has(k.toLowerCase()) ? REDACTED : walk(v, patterns),
      ]),
    );
  }
  return value;
}

/** Deep-copies obj and applies both redaction layers. Cycles and BigInts throw. */
export function redact<T>(obj: T): unknown {
  return walk(JSON.parse(JSON.stringify(obj) ?? "null"), secretPatterns());
}

/** Writes results/<testId>-<name>.json, redacted and pretty-printed, and returns its path. */
export function record(testId: string, name: string, data: unknown): string {
  const dir = new URL("./results/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`${testId}-${name}.json`, dir);
  writeFileSync(file, JSON.stringify(redact(data), null, 2) + "\n");
  return fileURLToPath(file);
}
