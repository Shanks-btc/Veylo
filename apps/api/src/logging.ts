// Same spirit as the verification redaction policy: redact by key name and by value shape.
const SECRET_KEY =
  /cookie|authorization|signature|token|secret|password|passwd|private|credential|api[-_]?key|jwt|master[-_]?key|nonce/i;

const SECRET_VALUES: readonly RegExp[] = [
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?/g, // JWT
  /\bBearer\s+\S+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g, // API keys
  /\bed25519:[1-9A-HJ-NP-Za-km-z]{60,}/g, // base58 signatures and private keys
  /\b[a-z]+:\/\/[^\s:/]+:[^\s@/]+@/gi, // credentials in a URL
  /[A-Za-z0-9+/_-]{43,}={0,2}/g, // long base64: session tokens, signatures, keys
];

const REDACTED = "[REDACTED]";

export function scrubText(text: string): string {
  return SECRET_VALUES.reduce((out, pattern) => out.replace(pattern, REDACTED), text);
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  // An Error or a framework object has its own serializer below.
  if (!isPlain(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? REDACTED : scrub(item, depth + 1),
    ]),
  );
}

/** Fastify logger options. Request logs carry no headers and no query string. */
export function loggerOptions(level: string, stream?: NodeJS.WritableStream, logClientIp = false) {
  return {
    level,
    ...(stream ? { stream } : {}),
    formatters: {
      log: (object: Record<string, unknown>) => scrub(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
        method.apply(
          this,
          args.map((arg) => (typeof arg === "string" ? scrubText(arg) : arg)),
        );
      },
    },
    serializers: {
      // The client IP is personal data: logged only with LOG_CLIENT_IP=true, for the L26 proxy
      // check in docs/DEPLOY.md, then turned off (L38). It's the address after TRUST_PROXY_HOPS.
      req: (req: { method: string; url: string; id?: string; ip?: string }) => ({
        id: req.id,
        method: req.method,
        path: req.url.split("?")[0],
        ...(logClientIp ? { ip: req.ip } : {}),
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      err: (err: Error & { code?: string }) => ({
        type: err.name,
        code: err.code ?? "",
        message: scrubText(err.message),
        stack: scrubText(err.stack ?? ""),
      }),
    },
  };
}
