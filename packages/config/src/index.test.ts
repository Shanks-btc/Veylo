import { describe, expect, it } from "vitest";
import {
  CONFIG_NAMES,
  ConfigError,
  loadApiConfig,
  loadMigrationConfig,
  loadSettlementWorkerConfig,
  loadWorkerConfig,
} from "./index.js";

const MASTER_KEY = `${"A".repeat(43)}=`;
const full = {
  DATABASE_URL: "postgres://user:password-sentinel@localhost:5432/veylo",
  ONECLICK_PARTNER_KEY: "partner-key-sentinel",
  NEARAI_API_KEY: "sk-nearai-sentinel",
  AGENT_KEY_MASTER_KEY: MASTER_KEY,
  NODE_ENV: "test",
  LOG_LEVEL: "info",
};
const apiExtras = {
  SESSION_ENCRYPTION_KEY: `${"B".repeat(43)}=`,
  AUTH_RECIPIENT: "veylo.app",
  WEB_ORIGIN: "https://app.veylo.app",
};
const fullApi = { ...full, ...apiExtras };

function captured(run: () => unknown): ConfigError {
  try {
    run();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected a ConfigError");
}

describe("per-service loaders", () => {
  it("each returns only what that service needs", () => {
    expect(Object.keys(loadApiConfig(fullApi)).sort()).toEqual(
      [
        "AUTH_RECIPIENT",
        "DATABASE_URL",
        "LOG_LEVEL",
        "NEAR_RPC_URL",
        "NODE_ENV",
        "ONECLICK_PARTNER_KEY",
        "ONECLICK_QUOTE_PUBLIC_KEY",
        "PAYOUT_QUOTE_DEADLINE_MINUTES",
        "PORT",
        "REVIEW_AMOUNT_DEVIATION_PERCENT",
        "SESSION_ENCRYPTION_KEY",
        "SESSION_TTL_HOURS",
        "TREASURY_LIMIT_ORG_PER_HOUR",
        "TREASURY_LIMIT_USER_PER_HOUR",
        "TRUST_PROXY_HOPS",
        "WEB_ORIGIN",
        "LOG_CLIENT_IP",
      ].sort(),
    );
    expect(Object.keys(loadMigrationConfig(full))).toEqual(["DATABASE_URL"]);
    expect(Object.keys(loadWorkerConfig(full)).sort()).toEqual(Object.keys(full).sort());
  });

  it("the API does not require worker-only secrets", () => {
    const { NEARAI_API_KEY, ...apiOnly } = fullApi;
    void NEARAI_API_KEY;
    expect(() => loadApiConfig(apiOnly)).not.toThrow();
    expect(() => loadWorkerConfig(apiOnly)).toThrow(ConfigError);
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(loadMigrationConfig(full))).toBe(true);
  });
});

describe("key separation (L31)", () => {
  it("the API never loads the agent key, even when it's in the environment", () => {
    const config = loadApiConfig({ ...fullApi, AGENT_KEY_MASTER_KEY: MASTER_KEY });
    expect(Object.keys(config)).not.toContain("AGENT_KEY_MASTER_KEY");
    expect(JSON.stringify(config)).not.toContain(MASTER_KEY);
  });

  it("the API starts without the agent key, and refuses to start without its own", () => {
    const { AGENT_KEY_MASTER_KEY, ...noAgent } = fullApi;
    void AGENT_KEY_MASTER_KEY;
    expect(() => loadApiConfig(noAgent)).not.toThrow();
    const { SESSION_ENCRYPTION_KEY, ...noSession } = fullApi;
    void SESSION_ENCRYPTION_KEY;
    expect(captured(() => loadApiConfig(noSession)).problems.map((p) => p.name)).toEqual([
      "SESSION_ENCRYPTION_KEY",
    ]);
  });

  it("the worker never loads the session key", () => {
    const config = loadWorkerConfig({ ...fullApi });
    expect(Object.keys(config)).toContain("AGENT_KEY_MASTER_KEY");
    expect(Object.keys(config)).not.toContain("SESSION_ENCRYPTION_KEY");
  });

  it("the old shared key name is gone", () => {
    expect(Object.keys(loadWorkerConfig(full))).not.toContain("VEYLO_MASTER_KEY");
  });

  it("rate limits default, and can be set", () => {
    expect(loadApiConfig(fullApi)).toMatchObject({
      TREASURY_LIMIT_ORG_PER_HOUR: 60,
      TREASURY_LIMIT_USER_PER_HOUR: 30,
    });
    expect(
      loadApiConfig({ ...fullApi, TREASURY_LIMIT_ORG_PER_HOUR: "5" }).TREASURY_LIMIT_ORG_PER_HOUR,
    ).toBe(5);
    expect(() => loadApiConfig({ ...fullApi, TREASURY_LIMIT_USER_PER_HOUR: "0" })).toThrow(
      ConfigError,
    );
  });
});

describe("two worker roles (L36)", () => {
  it("worker:settlement never loads the agent key", () => {
    const config = loadSettlementWorkerConfig({ ...fullApi, AGENT_KEY_MASTER_KEY: MASTER_KEY });
    expect(Object.keys(config)).toContain("SESSION_ENCRYPTION_KEY");
    expect(Object.keys(config)).not.toContain("AGENT_KEY_MASTER_KEY");
  });

  it("worker:agents never loads the session key", () => {
    const config = loadWorkerConfig({ ...fullApi, AGENT_KEY_MASTER_KEY: MASTER_KEY });
    expect(Object.keys(config)).toContain("AGENT_KEY_MASTER_KEY");
    expect(Object.keys(config)).not.toContain("SESSION_ENCRYPTION_KEY");
    expect(JSON.stringify(config)).not.toContain(fullApi.SESSION_ENCRYPTION_KEY);
  });
});

describe("the settlement worker (L38)", () => {
  const own = {
    DATABASE_URL: full.DATABASE_URL,
    ONECLICK_PARTNER_KEY: full.ONECLICK_PARTNER_KEY,
    SESSION_ENCRYPTION_KEY: apiExtras.SESSION_ENCRYPTION_KEY,
    NODE_ENV: "production",
    LOG_LEVEL: "info",
  };
  it("loads only what it reads: the session key (L36), never the agent key (L31)", () => {
    const config = loadSettlementWorkerConfig({ ...fullApi, AGENT_KEY_MASTER_KEY: MASTER_KEY });
    expect(Object.keys(config).sort()).toEqual(
      [
        "DATABASE_URL",
        "LOG_LEVEL",
        "NEAR_RPC_URL",
        "NODE_ENV",
        "ONECLICK_PARTNER_KEY",
        "ONECLICK_QUOTE_PUBLIC_KEY",
        "SESSION_ENCRYPTION_KEY",
      ].sort(),
    );
    expect(Object.keys(config)).not.toContain("AGENT_KEY_MASTER_KEY");
    expect(JSON.stringify(config)).not.toContain(MASTER_KEY);
  });
  it("no longer requires AUTH_RECIPIENT, WEB_ORIGIN or PORT, and ignores a bad PORT", () => {
    expect(() => loadSettlementWorkerConfig(own)).not.toThrow();
    expect(() => loadSettlementWorkerConfig({ ...own, PORT: "0" })).not.toThrow();
    const keys = Object.keys(loadSettlementWorkerConfig(own));
    for (const name of ["AUTH_RECIPIENT", "WEB_ORIGIN", "PORT"]) expect(keys).not.toContain(name);
  });
});

describe("each process boots with only its own variables", () => {
  it("api", () => {
    const own = Object.fromEntries(
      CONFIG_NAMES.api.map((n) => [n, (fullApi as Record<string, string>)[n]]),
    );
    expect(() => loadApiConfig(own)).not.toThrow();
  });
  it("worker:settlement", () => {
    const own = Object.fromEntries(
      CONFIG_NAMES["worker:settlement"].map((n) => [n, (fullApi as Record<string, string>)[n]]),
    );
    expect(() => loadSettlementWorkerConfig(own)).not.toThrow();
  });
  it("worker:agents", () => {
    const own = Object.fromEntries(
      CONFIG_NAMES["worker:agents"].map((n) => [n, (full as Record<string, string>)[n]]),
    );
    expect(() => loadWorkerConfig(own)).not.toThrow();
  });
  it("migrate", () => {
    expect(() => loadMigrationConfig({ DATABASE_URL: full.DATABASE_URL })).not.toThrow();
  });
  it("only the api set has SESSION_ENCRYPTION_KEY besides the settlement worker; only agents has the agent key", () => {
    for (const [name, list] of Object.entries(CONFIG_NAMES)) {
      expect((list as readonly string[]).includes("AGENT_KEY_MASTER_KEY")).toBe(
        name === "worker:agents",
      );
      expect((list as readonly string[]).includes("SESSION_ENCRYPTION_KEY")).toBe(
        name === "api" || name === "worker:settlement",
      );
    }
  });
});

describe("LOG_CLIENT_IP", () => {
  it("defaults to false and accepts only true or false", () => {
    expect(loadApiConfig(fullApi).LOG_CLIENT_IP).toBe(false);
    expect(loadApiConfig({ ...fullApi, LOG_CLIENT_IP: "true" }).LOG_CLIENT_IP).toBe(true);
    expect(() => loadApiConfig({ ...fullApi, LOG_CLIENT_IP: "yes" })).toThrow(ConfigError);
  });
});

describe("API settings added for sign-in", () => {
  it("applies the documented defaults to non-secrets", () => {
    expect(loadApiConfig(fullApi)).toMatchObject({
      NEAR_RPC_URL: "https://rpc.fastnear.com",
      SESSION_TTL_HOURS: 24,
      PORT: 3000,
      TRUST_PROXY_HOPS: 0,
    });
  });

  it("reads overrides, as numbers where needed", () => {
    expect(
      loadApiConfig({ ...fullApi, SESSION_TTL_HOURS: "12", NEAR_RPC_URL: "https://rpc.test" }),
    ).toMatchObject({ SESSION_TTL_HOURS: 12, NEAR_RPC_URL: "https://rpc.test" });
  });

  it("requires the recipient and web origin, which have no safe default", () => {
    expect(
      captured(() => loadApiConfig(full))
        .problems.map((p) => p.name)
        .sort(),
    ).toEqual(["AUTH_RECIPIENT", "SESSION_ENCRYPTION_KEY", "WEB_ORIGIN"]);
  });

  it.each([
    ["WEB_ORIGIN", "https://app.veylo.app/path"],
    ["WEB_ORIGIN", "*"],
    ["NEAR_RPC_URL", "http://rpc.test"],
    ["SESSION_TTL_HOURS", "0"],
    ["SESSION_TTL_HOURS", "1.5"],
    ["TRUST_PROXY_HOPS", "-1"],
    ["TRUST_PROXY_HOPS", "true"],
    ["AUTH_RECIPIENT", "Not A Host"],
  ])("rejects %s=%s", (name, value) => {
    const err = captured(() => loadApiConfig({ ...fullApi, [name]: value }));
    expect(err.problems).toMatchObject([{ name, problem: "invalid" }]);
  });
});

describe("errors", () => {
  it("names every missing variable and how to fix it", () => {
    const err = captured(() => loadWorkerConfig({}));
    expect(err.problems.map((p) => p.name).sort()).toEqual(Object.keys(full).sort());
    expect(err.problems.every((p) => p.problem === "missing")).toBe(true);
    expect(err.message).toContain("DATABASE_URL is missing");
    expect(err.message).toContain(".env.example");
  });

  it("treats a blank value as missing", () => {
    const err = captured(() => loadMigrationConfig({ ...full, DATABASE_URL: "   " }));
    expect(err.problems).toEqual([expect.objectContaining({ problem: "missing" })]);
  });

  it.each([
    ["DATABASE_URL", "mysql://secret-value-sentinel@host/db"],
    ["NEARAI_API_KEY", "secret-value-sentinel"],
    ["AGENT_KEY_MASTER_KEY", "secret-value-sentinel"],
    ["NODE_ENV", "secret-value-sentinel"],
    ["LOG_LEVEL", "secret-value-sentinel"],
  ])("reports invalid %s without printing its value", (name, value) => {
    const err = captured(() => loadWorkerConfig({ ...full, [name]: value }));
    expect(err.problems).toEqual([expect.objectContaining({ name, problem: "invalid" })]);
    const everything = `${err.message}\n${err.stack}\n${JSON.stringify(err)}`;
    expect(everything).not.toContain("secret-value-sentinel");
  });

  it("never prints valid values sitting beside an invalid one", () => {
    const err = captured(() => loadWorkerConfig({ ...full, LOG_LEVEL: "loud" }));
    const everything = `${err.message}\n${err.stack}\n${JSON.stringify(err)}`;
    for (const sentinel of ["password-sentinel", "partner-key-sentinel", "sk-nearai", MASTER_KEY]) {
      expect(everything).not.toContain(sentinel);
    }
  });
});
