import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scrub, scrubText } from "./logging.js";
import {
  challenge,
  createHarness,
  createOrg,
  RECIPIENT,
  sessionCookie,
  verify,
  Wallet,
} from "./test-support.js";

let h: Awaited<ReturnType<typeof createHarness>>;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.client.close();
});

const capture = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, stream };
};

const config = {
  authRecipient: RECIPIENT,
  webOrigin: "https://app.veylo.test",
  sessionTtlHours: 24,
};

describe("GET /health", () => {
  it("needs no auth", async () => {
    const app = await h.build();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("error shape", () => {
  it("unknown route", async () => {
    const app = await h.build();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
    await app.close();
  });

  it("malformed JSON", async () => {
    const app = await h.build();
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "INVALID_REQUEST", message: "Invalid request" } });
    await app.close();
  });

  it("an unsupported content type", async () => {
    const app = await h.build();
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "content-type": "application/xml" },
      payload: "<x/>",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("INVALID_REQUEST");
    await app.close();
  });

  it("an internal failure leaks nothing, and is logged", async () => {
    const { lines, stream } = capture();
    const failing = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("secret internal detail at /srv/db.ts");
        },
      },
    );
    const app = await h.build({
      db: failing as never,
      logStream: stream,
      config: { ...config, logLevel: "info" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { accountId: "a.near" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "INTERNAL", message: "Internal error" } });
    expect(res.body).not.toContain("secret internal");
    expect(res.body).not.toContain("stack");
    expect(lines.join("")).toContain("request failed");
    await app.close();
  });
});

describe("security plugins", () => {
  it("helmet sets its headers", async () => {
    const app = await h.build();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeDefined();
    await app.close();
  });

  it("CORS allows only WEB_ORIGIN, with credentials", async () => {
    const app = await h.build();
    const allowed = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://app.veylo.test" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.veylo.test");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    const other = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.test" },
    });
    expect(other.headers["access-control-allow-origin"]).not.toBe("https://evil.test");
    await app.close();
  });

  it("rate limits /auth/* with the standard error shape, and not other routes", async () => {
    const app = await h.build({ authRateLimitPerMinute: 2 });
    const post = () =>
      app.inject({ method: "POST", url: "/auth/challenge", payload: { accountId: "a.near" } });
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
    const limited = await post();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    });
    for (let i = 0; i < 4; i += 1) {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    }
    await app.close();
  });
});

describe("logs", () => {
  it("a whole sign-in flow at trace level leaks no token, signature or header", async () => {
    const { lines, stream } = capture();
    const app = await h.build({
      logStream: stream,
      config: { ...config, logLevel: "trace" },
    });
    const wallet = new Wallet();
    const c = await challenge(app, wallet.accountId);
    const signature = wallet.sign(c.message, c.nonce, RECIPIENT);
    const res = await verify(app, wallet, c);
    const cookies = sessionCookie(res);
    const token = Object.values(cookies)[0] as string;
    await createOrg(app, cookies);
    await app.inject({
      method: "GET",
      url: "/me?token=query-sentinel",
      cookies,
      headers: { authorization: "Bearer header-sentinel" },
    });
    await app.inject({ method: "POST", url: "/auth/logout", cookies });

    const log = lines.join("");
    expect(lines.length).toBeGreaterThan(5); // The capture really saw the requests.
    for (const secret of [
      token,
      signature,
      c.nonce,
      "query-sentinel",
      "header-sentinel",
      "veylo_session",
    ]) {
      expect(log).not.toContain(secret);
    }
    await app.close();
  });

  it("redacts secret-like fields and values passed to the logger directly", async () => {
    const { lines, stream } = capture();
    const app = await h.build({
      logStream: stream,
      config: { ...config, logLevel: "info" },
    });
    app.log.info(
      {
        signature: "sentinel-1",
        nested: { token: "sentinel-2", deep: [{ apiKey: "sentinel-3" }] },
        headers: { cookie: "sentinel-4", authorization: "sentinel-5" },
        note: `jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl`,
      },
      "password in postgres://user:sentinel-6@host/db",
    );
    const log = lines.join("");
    for (let i = 1; i <= 6; i += 1) expect(log).not.toContain(`sentinel-${i}`);
    expect(log).not.toContain("eyJhbGci");
    expect(log).toContain("[REDACTED]");
    await app.close();
  });

  it("an RPC failure's log has no secret", async () => {
    const { lines, stream } = capture();
    const app = await h.build({
      logStream: stream,
      config: { ...config, logLevel: "info" },
    });
    const wallet = new Wallet("named-for-log.near");
    const c = await challenge(app, wallet.accountId);
    h.rpcHooks.fail = true;
    const res = await verify(app, wallet, c);
    h.rpcHooks.fail = false;
    expect(res.statusCode).toBe(401);
    const log = lines.join("");
    expect(log).toContain("key ownership check failed");
    expect(log).not.toContain(wallet.sign(c.message, c.nonce, RECIPIENT));
    await app.close();
  });
});

describe("scrub", () => {
  it("keeps ordinary data", () => {
    expect(scrub({ path: "/orgs/1", statusCode: 200, ok: true, n: null })).toEqual({
      path: "/orgs/1",
      statusCode: 200,
      ok: true,
      n: null,
    });
    expect(scrubText("request completed")).toBe("request completed");
  });

  it.each([
    ["an API key", "key sk-abcdef123456"],
    ["a bearer token", "Bearer abc.def"],
    ["a long base64 value", "x".repeat(43)],
    ["a base58 signature", `ed25519:${"5".repeat(80)}`],
  ])("removes %s", (_name, text) => {
    expect(scrubText(text)).toContain("[REDACTED]");
  });
});

describe("TRUST_PROXY_HOPS", () => {
  const post = (app: Awaited<ReturnType<typeof h.build>>, ip: string) =>
    app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "x-forwarded-for": ip },
      payload: { accountId: "a.near" },
    });

  it("0: a forwarded IP is ignored, so spoofing it can't dodge the limit", async () => {
    const app = await h.build({
      authRateLimitPerMinute: 1,
      config: { ...config, logLevel: "silent", trustProxyHops: 0 },
    });
    expect((await post(app, "203.0.113.1")).statusCode).toBe(200);
    expect((await post(app, "203.0.113.2")).statusCode).toBe(429);
    await app.close();
  });

  it("1: a client can't dodge the limit by prefixing its own forwarded entries", async () => {
    const app = await h.build({
      authRateLimitPerMinute: 1,
      config: { ...config, logLevel: "silent", trustProxyHops: 1 },
    });
    expect((await post(app, "1.1.1.1, 203.0.113.9")).statusCode).toBe(200);
    expect((await post(app, "2.2.2.2, 203.0.113.9")).statusCode).toBe(429);
    await app.close();
  });

  it("1: the proxy's forwarded IP is what's limited", async () => {
    const app = await h.build({
      authRateLimitPerMinute: 1,
      config: { ...config, logLevel: "silent", trustProxyHops: 1 },
    });
    expect((await post(app, "203.0.113.1")).statusCode).toBe(200);
    expect((await post(app, "203.0.113.2")).statusCode).toBe(200);
    expect((await post(app, "203.0.113.1")).statusCode).toBe(429);
    await app.close();
  });

  it.each([
    [0, "1.1.1.1, 203.0.113.9", "127.0.0.1"],
    [1, "1.1.1.1, 203.0.113.9", "203.0.113.9"],
  ])(
    "%i: the request log shows the client IP the API resolved (the DEPLOY.md L26 check)",
    async (hops, xff, ip) => {
      const { lines, stream } = capture();
      const app = await h.build({
        logStream: stream,
        config: { ...config, logLevel: "info", trustProxyHops: hops, logClientIp: true },
      });
      await app.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": xff } });
      await app.close();
      const incoming = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "incoming request");
      expect(incoming.req).toEqual({ id: expect.any(String), method: "GET", path: "/health", ip });
    },
  );

  it.each([undefined, false])(
    "LOG_CLIENT_IP %s: no request log line carries an ip field (L38)",
    async (flag) => {
      const { lines, stream } = capture();
      const app = await h.build({
        logStream: stream,
        config: { ...config, logLevel: "info", trustProxyHops: 1, logClientIp: flag },
      });
      await app.inject({
        method: "GET",
        url: "/health",
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      await app.close();
      const parsed = lines.map((l) => JSON.parse(l));
      const incoming = parsed.find((l) => l.msg === "incoming request");
      expect(incoming.req).toEqual({ id: expect.any(String), method: "GET", path: "/health" });
      expect(lines.join("\n")).not.toContain("203.0.113.9");
      expect(parsed.some((l) => l.req && "ip" in l.req)).toBe(false);
    },
  );
});
