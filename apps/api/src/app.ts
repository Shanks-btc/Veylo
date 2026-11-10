import { createHash } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { IntentsReader, NearRpc } from "@veylo/chains";
import { checkReadiness, type Db } from "@veylo/db";
import type { OneClickDryClient, OneClickTreasuryClient } from "@veylo/intents";
import type { SecretBox } from "@veylo/secrets";
import Fastify from "fastify";
import type { z } from "zod";
import { authRoutes } from "./auth-routes.js";
import { AppError, invalidRequest } from "./errors.js";
import { contractorRoutes } from "./contractor-routes.js";
import { createGuards } from "./guards.js";
import { loggerOptions } from "./logging.js";
import { orgRoutes } from "./org-routes.js";
import { payeeRoutes } from "./payee-routes.js";
import { payRunRoutes } from "./pay-run-routes.js";
import { payoutRoutes } from "./payout-routes.js";
import { reportingRoutes } from "./reporting-routes.js";
import { treasuryRoutes } from "./treasury-routes.js";

export type Deps = {
  db: Db;
  clock: () => Date;
  random: (bytes: number) => Uint8Array;
  rpc: NearRpc;
  oneclick: OneClickDryClient;
  oneclickTreasury: OneClickTreasuryClient;
  intents: IntentsReader;
  secrets: SecretBox;
  config: {
    authRecipient: string;
    webOrigin: string;
    sessionTtlHours: number;
    logLevel: string;
    /** Defaults: 60 per org and 30 per user, per route, per hour. */
    treasuryLimitPerOrgPerHour?: number;
    treasuryLimitPerUserPerHour?: number;
    /** Payout quote deadline, in minutes (L34). Default 15. */
    payoutQuoteDeadlineMinutes?: number;
    /** Amount deviation that flags an item, in percent. Default 25. */
    reviewDeviationPercent?: number;
    /** TRUST_PROXY_HOPS: proxy hops to trust for the client IP that rate limiting keys on. */
    trustProxyHops?: number;
    logClientIp?: boolean;
  };
  /** Tests capture log output here. */
  logStream?: NodeJS.WritableStream;
  authRateLimitPerMinute?: number;
};

export const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  // The validator's message can echo input, so it never leaves here.
  if (!result.success) throw invalidRequest();
  return result.data;
}

export async function buildServer(deps: Deps) {
  const hops = deps.config.trustProxyHops ?? 0;
  const app = Fastify({
    logger: loggerOptions(deps.config.logLevel, deps.logStream, deps.config.logClientIp ?? false),
    // Fastify deliberately ignores a numeric trustProxy, so the hop rule is a function. It assumes
    // every request arrives through those proxies; verify that at deploy (TRUST_PROXY_HOPS).
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
  });

  // The route list lets a test prove that every org-scoped route has a cross-tenant test.
  const routes: { method: string; url: string }[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      if (method !== "HEAD") routes.push({ method, url: route.url });
    }
  });
  app.decorate("routeList", routes);

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    const status = error.statusCode ?? 500;
    if (status === 429) {
      return reply.status(429).send({
        error: { code: "RATE_LIMITED", message: "Too many requests" },
      });
    }
    if (status >= 400 && status < 500) {
      return reply
        .status(status)
        .send({ error: { code: "INVALID_REQUEST", message: "Invalid request" } });
    }
    request.log.error({ err: error }, "request failed");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Internal error" } });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "Not found" } }),
  );

  await app.register(helmet);
  await app.register(cors, { origin: deps.config.webOrigin, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error("Too many requests"), { statusCode: context.statusCode }),
  });

  // Liveness: the process answers. Never touches the database.
  app.get("/health", async () => ({ status: "ok" }));
  // Readiness (L37): the database answers and no migration is pending. The reason never holds a
  // secret, a URL or a driver message.
  app.get("/ready", async (_request, reply) => {
    const r = await checkReadiness(deps.db);
    return r.ready
      ? { status: "ready" }
      : reply.status(503).send({ status: "not_ready", reason: r.reason });
  });

  const guards = createGuards(deps);
  await authRoutes(app, deps, guards);
  await orgRoutes(app, deps, guards);
  await contractorRoutes(app, deps, guards);
  await payeeRoutes(app, deps, guards);
  await treasuryRoutes(app, deps, guards);
  await payRunRoutes(app, deps, guards);
  await payoutRoutes(app, deps, guards);
  await reportingRoutes(app, deps, guards);
  return app;
}
