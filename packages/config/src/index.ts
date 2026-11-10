import { z } from "zod";

function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/),
  ONECLICK_PARTNER_KEY: z.string().min(1),
  NEARAI_API_KEY: z.string().regex(/^sk-\S+$/),
  /** API only: encrypts 1Click session tokens, read-only data (L31). */
  SESSION_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  /** Worker only: encrypts agent keys, which control funds (L31). The API must never load it. */
  AGENT_KEY_MASTER_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  NODE_ENV: z.enum(["development", "test", "production"]),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
  // Non-secrets may have documented defaults. Secrets never do.
  NEAR_RPC_URL: z
    .string()
    .regex(/^https:\/\/\S+$/)
    .default("https://rpc.fastnear.com"),
  AUTH_RECIPIENT: z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/),
  WEB_ORIGIN: z.string().refine(isOrigin),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /** Log the resolved client IP on each request line. Only for the L26 proxy check (L38). */
  LOG_CLIENT_IP: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  TREASURY_LIMIT_ORG_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(60),
  TREASURY_LIMIT_USER_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(30),
  PAYOUT_QUOTE_DEADLINE_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  REVIEW_AMOUNT_DEVIATION_PERCENT: z.coerce.number().int().min(1).max(1000).default(25),
  ONECLICK_QUOTE_PUBLIC_KEY: z
    .string()
    .regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/)
    .default("ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc"),
});

type EnvName = keyof z.infer<typeof envSchema>;

/** Written by hand so an error can never echo a value, which a validator's own message might. */
const EXPECTED: Record<EnvName, string> = {
  DATABASE_URL: "a postgres:// or postgresql:// connection URL",
  ONECLICK_PARTNER_KEY: "the 1Click partner JWT from partners.near-intents.org",
  NEARAI_API_KEY: "a NEAR AI Cloud API key starting with sk-",
  SESSION_ENCRYPTION_KEY: "32 random bytes, base64 encoded (44 characters ending in =)",
  AGENT_KEY_MASTER_KEY: "32 random bytes, base64 encoded (44 characters ending in =)",
  TREASURY_LIMIT_ORG_PER_HOUR: "requests per org, per route, per hour, 1 to 10000 (default 60)",
  TREASURY_LIMIT_USER_PER_HOUR: "requests per user, per route, per hour, 1 to 10000 (default 30)",
  PAYOUT_QUOTE_DEADLINE_MINUTES: "minutes, 1 to 60 (default 15)",
  REVIEW_AMOUNT_DEVIATION_PERCENT: "a whole percent, 1 to 1000 (default 25)",
  ONECLICK_QUOTE_PUBLIC_KEY:
    "ed25519:<base58>, 1Click's quote-signing key (default: the key pinned in S-C)",
  NODE_ENV: "one of development, test, production",
  LOG_LEVEL: "one of fatal, error, warn, info, debug, trace",
  NEAR_RPC_URL: "an https:// NEAR RPC URL (default https://rpc.fastnear.com)",
  AUTH_RECIPIENT: "the app identifier wallets sign for, such as veylo.app",
  WEB_ORIGIN: "the web app's origin, such as https://app.veylo.app, with no path",
  SESSION_TTL_HOURS: "a whole number of hours from 1 to 720 (default 24)",
  PORT: "a port number (default 3000)",
  TRUST_PROXY_HOPS: "a whole number of proxy hops from 0 to 10 (default 0, off)",
  LOG_CLIENT_IP: "true or false (default false)",
};

export type ConfigProblem = {
  name: EnvName;
  problem: "missing" | "invalid";
  expected: string;
};

/** Names what is wrong and what is expected. It never contains a value. */
export class ConfigError extends Error {
  constructor(
    readonly service: string,
    readonly problems: readonly ConfigProblem[],
  ) {
    const lines = problems.map((p) => `  - ${p.name} is ${p.problem}. Expected ${p.expected}.`);
    super(
      `Invalid environment for ${service}:\n${lines.join("\n")}\nSet these in the environment. See .env.example.`,
    );
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function load<K extends EnvName>(
  service: string,
  names: readonly K[],
  env: Env,
): Readonly<Pick<z.infer<typeof envSchema>, K>> {
  const mask = Object.fromEntries(names.map((name) => [name, true])) as Record<K, true>;
  const schema = envSchema.pick(mask as never);
  const candidate = Object.fromEntries(
    names.map((name) => [name, env[name]?.trim() ? env[name] : undefined]),
  );
  const result = schema.safeParse(candidate);
  if (!result.success) {
    const problems = [...new Set(result.error.issues.map((issue) => issue.path[0] as K))].map(
      (name): ConfigProblem => ({
        name,
        problem: candidate[name] === undefined ? "missing" : "invalid",
        expected: EXPECTED[name],
      }),
    );
    // The validator's error is dropped deliberately: only the names above leave this function.
    throw new ConfigError(service, problems);
  }
  return Object.freeze(result.data) as Readonly<Pick<z.infer<typeof envSchema>, K>>;
}

const API = [
  "DATABASE_URL",
  "ONECLICK_PARTNER_KEY",
  "SESSION_ENCRYPTION_KEY",
  "TREASURY_LIMIT_ORG_PER_HOUR",
  "TREASURY_LIMIT_USER_PER_HOUR",
  "NODE_ENV",
  "LOG_LEVEL",
  "NEAR_RPC_URL",
  "AUTH_RECIPIENT",
  "WEB_ORIGIN",
  "SESSION_TTL_HOURS",
  "PORT",
  "TRUST_PROXY_HOPS",
  "LOG_CLIENT_IP",
  "PAYOUT_QUOTE_DEADLINE_MINUTES",
  "REVIEW_AMOUNT_DEVIATION_PERCENT",
  "ONECLICK_QUOTE_PUBLIC_KEY",
] as const;
const WORKER = [
  "DATABASE_URL",
  "ONECLICK_PARTNER_KEY",
  "NEARAI_API_KEY",
  "AGENT_KEY_MASTER_KEY",
  "NODE_ENV",
  "LOG_LEVEL",
] as const;
/**
 * The settlement worker reads only these (L38). It keeps the session key to decrypt the signed
 * payloads it resubmits (L36), and never loads the agent key (L31).
 */
const SETTLEMENT = [
  "DATABASE_URL",
  "ONECLICK_PARTNER_KEY",
  "ONECLICK_QUOTE_PUBLIC_KEY",
  "SESSION_ENCRYPTION_KEY",
  "NEAR_RPC_URL",
  "NODE_ENV",
  "LOG_LEVEL",
] as const;
const MIGRATIONS = ["DATABASE_URL"] as const;

/** The API talks to 1Click and Postgres, and encrypts 1Click session tokens (L30). It holds no NEAR AI key and no agent key (L31). */
export const loadApiConfig = (env: Env = process.env) => load("api", API, env);

/** The worker is the only process that decrypts agent keys and calls NEAR AI (ARCHITECTURE §2, §5). */
export const loadWorkerConfig = (env: Env = process.env) => load("worker", WORKER, env);

/**
 * The settlement worker (slice 5b) is API-tier: it needs the session key to read balances and the
 * signed payloads it resubmits, and never the agent key (L31). The agent worker comes in slice 8.
 */
export const loadSettlementWorkerConfig = (env: Env = process.env) =>
  load("settlement-worker", SETTLEMENT, env);

/** Applying migrations needs only the database. */
export const CONFIG_NAMES = {
  api: API,
  "worker:settlement": SETTLEMENT,
  "worker:agents": WORKER,
  migrate: MIGRATIONS,
} as const;
export const loadMigrationConfig = (env: Env = process.env) => load("migrations", MIGRATIONS, env);
