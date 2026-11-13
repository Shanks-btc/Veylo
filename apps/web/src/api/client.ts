// Typed client for every API route (slice W1). Every response is validated against the shared
// contract (@veylo/contract); an invalid response throws and is never partially used. The session
// is the API's httpOnly cookie only: nothing is stored in localStorage or readable by script.
import { errorResponse, ROUTES, type RouteKey, type RouteResponse } from "@veylo/contract";

/** The API answered with its error body (a 4xx or 5xx). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The API answered with something the contract doesn't allow, or couldn't be reached. */
export class ApiContractError extends Error {
  constructor(
    readonly route: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiContractError";
  }
}

type Method<K extends string> = K extends `${infer M} ${string}` ? M : never;
type Path<K extends string> = K extends `${string} ${infer P}` ? P : never;
type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;
export type RouteParams<K extends RouteKey> = [ParamNames<Path<K>>] extends [never]
  ? Record<string, never>
  : Record<ParamNames<Path<K>>, string>;

export type CallOptions<K extends RouteKey> = {
  params?: RouteParams<K>;
  body?: unknown;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
};

const SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** Fills `:name` segments. Each value must be a plain path segment, so nothing can be injected. */
export function buildPath(template: string, params: Record<string, string> = {}): string {
  return template.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined || !SAFE_SEGMENT.test(value)) {
      throw new ApiContractError(template, `bad or missing path parameter: ${name}`);
    }
    return value;
  });
}

export type ApiClient = {
  call<K extends RouteKey>(key: K, options?: CallOptions<K>): Promise<RouteResponse<K>>;
};

export function createApiClient(options: {
  origin: string;
  fetch: typeof globalThis.fetch;
}): ApiClient {
  const origin = new URL(options.origin).origin;
  return {
    async call(key, call = {}) {
      const schema = ROUTES[key];
      const [method, template] = key.split(" ") as [Method<typeof key>, Path<typeof key>];
      const url = new URL(buildPath(template, call.params as Record<string, string>), origin);
      for (const [k, v] of Object.entries(call.query ?? {}))
        if (v !== undefined) url.searchParams.set(k, v);
      if (url.origin !== origin) throw new ApiContractError(key, "request left the API origin");

      let response: Response;
      try {
        response = await options.fetch(url, {
          method,
          credentials: "include",
          headers: call.body === undefined ? {} : { "content-type": "application/json" },
          body: call.body === undefined ? undefined : JSON.stringify(call.body),
          signal: call.signal,
          redirect: "error",
        });
      } catch (err) {
        throw new ApiContractError(
          key,
          `the API is unreachable: ${err instanceof Error ? err.message : "error"}`,
        );
      }

      const text = await response.text().catch(() => {
        throw new ApiContractError(key, "unreadable response");
      });
      if (!response.ok) {
        let parsed: ReturnType<typeof errorResponse.safeParse> | undefined;
        try {
          parsed = errorResponse.safeParse(JSON.parse(text));
        } catch {
          parsed = undefined;
        }
        if (!parsed?.success)
          throw new ApiContractError(key, `HTTP ${response.status} without an error body`);
        throw new ApiError(response.status, parsed.data.error.code, parsed.data.error.message);
      }
      if (schema === "csv") {
        if (!(response.headers.get("content-type") ?? "").startsWith("text/csv")) {
          throw new ApiContractError(key, "expected text/csv");
        }
        return text as RouteResponse<typeof key>;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiContractError(key, "the response isn't JSON");
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success)
        throw new ApiContractError(key, "the response doesn't match the contract");
      return parsed.data as RouteResponse<typeof key>;
    },
  };
}
