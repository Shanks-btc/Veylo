// Test support only. Every wallet here is a throwaway key made for the test; no network is used.
import { PAYOUT_ROUTE_IDS } from "@veylo/core";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { ROUTES, type RouteKey } from "@veylo/contract";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { createIntentsReader, createNearRpc } from "@veylo/chains";
import { createTestDb } from "@veylo/db/test-db";
import {
  createOneClickDryClient,
  createOneClickTreasuryClient,
  hashNep413,
  oneClickQuoteHash,
} from "@veylo/intents";
import { createSecretBox } from "@veylo/secrets";
import { CONFIDENTIAL_TOKEN_PREFIX } from "./payout-routes.js";
import { createHash } from "node:crypto";
import { buildServer, type Deps } from "./app.js";
import { SESSION_COOKIE } from "./guards.js";

export const RECIPIENT = "veylo.test";
export const QUOTE_KEY = "partner-key-sentinel";
export const ACCESS_TOKEN = "access-token-sentinel";
export const REFRESH_TOKEN = "refresh-token-sentinel";
const MASTER_KEY = randomBytes(32).toString("base64");
/** Stands in for 1Click's quote-signing key. */
const QUOTE_SIGNER = ed25519.utils.randomSecretKey();
export const QUOTE_SIGNER_PUBLIC = `ed25519:${base58.encode(ed25519.getPublicKey(QUOTE_SIGNER))}`;
export const signQuote = (response: object, secret = QUOTE_SIGNER) =>
  `ed25519:${base58.encode(
    ed25519.sign(new TextEncoder().encode(oneClickQuoteHash(response as never)), secret),
  )}`;
const TREASURY_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const fixtureResponse = (name: string) => () => {
  const url = new URL(
    `../../../packages/intents/src/fixtures/oneclick-${name}.json`,
    import.meta.url,
  );
  const { status, body } = JSON.parse(readFileSync(url, "utf8"));
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
};

export type App = Awaited<ReturnType<typeof buildServer>>;

export class Wallet {
  readonly secret = ed25519.utils.randomSecretKey();
  readonly publicBytes = ed25519.getPublicKey(this.secret);
  readonly publicKey = `ed25519:${base58.encode(this.publicBytes)}`;
  /** Implicit by default; pass a name for a named account. */
  readonly accountId: string;

  constructor(name?: string) {
    this.accountId = name ?? Buffer.from(this.publicBytes).toString("hex");
  }

  sign(message: string, nonce: string, recipient: string): string {
    const hash = hashNep413({ message, nonce: base64.decode(nonce), recipient });
    return base64.encode(ed25519.sign(hash, this.secret));
  }
}

const randomizeTail = (nonce: Buffer) => {
  randomBytes(23).copy(nonce, 9);
  return nonce;
};

let counter = 0;
export const namedWallet = () => new Wallet(`test-${Date.now()}-${(counter += 1)}.near`);

/** One database per test file. Accounts are random, so tests don't collide. */
export async function createHarness() {
  const { db, client } = await createTestDb();
  const clock = { now: new Date("2026-11-06T10:00:00.000Z") };
  /** account -> public key -> permission, as a NEAR node would report it. */
  const chain = new Map<string, Map<string, unknown>>();
  const rpcHooks: { before?: () => Promise<void>; fail?: boolean; calls: number } = { calls: 0 };

  /** A stand-in for 1Click, answering in the shapes recorded in T5, T5b and T6. */
  const one = {
    salt: "252812b3",
    publicBalance: "1000000",
    privateBalance: "500000" as string | null,
    requests: [] as { path: string; body: any }[],
    lastBearer: "",
    authStatus: 201,
    refreshStatus: 201,
    balancesStatus: 200,
    submitStatus: 201,
    statusHttp: 200,
    statuses: [] as string[],
    quoteReject: "",
    signer: signQuote as (r: object) => string,
    echoChange: {} as Record<string, unknown>,
    tamperIntent: {} as {
      token?: string;
      receiver?: string;
      amount?: string;
      signer?: string;
      recipient?: string;
      salt?: string;
    },
    deposits: 0,
    quotes: new Map<string, { amountIn: string; depositType: string }>(),
    submitQueue: [] as string[],
    statusByDeposit: new Map<string, string[]>(),
    refundedAmount: "0",
    /** USD per NEAR: what the token list shows, and what a NEAR quote is priced at (W6). */
    nearListPrice: "3.43",
    nearQuotePrice: "3.43",
    tokensStatus: 200,
    saltReads: [] as string[],
    messageDeadline: "2026-11-10T10:15:00.000Z",
    reset() {
      one.salt = "252812b3";
      one.publicBalance = "1000000";
      one.privateBalance = "500000";
      one.requests = [];
      one.lastBearer = "";
      one.authStatus = 201;
      one.refreshStatus = 201;
      one.balancesStatus = 200;
      one.submitStatus = 201;
      one.statusHttp = 200;
      one.statuses = [];
      one.quoteReject = "";
      one.signer = signQuote;
      one.echoChange = {};
      one.tamperIntent = {};
      one.submitQueue = [];
      one.statusByDeposit = new Map();
      one.refundedAmount = "0";
      one.nearListPrice = "3.43";
      one.nearQuotePrice = "3.43";
      one.tokensStatus = 200;
      one.saltReads = [];
    },
  };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const oneFetch = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://1click.chaindefuser.com", "");
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    one.requests.push({ path, body });
    const headers = init.headers as Record<string, string>;
    if (headers.authorization) one.lastBearer = headers.authorization.replace("Bearer ", "");
    if (path === "/v0/tokens") {
      // The price is text in the response, as 1Click writes it.
      if (one.tokensStatus !== 200) return reply(one.tokensStatus, {});
      return new Response(
        `[{"assetId":"nep141:wrap.near","decimals":24,"blockchain":"near","symbol":"wNEAR","price":${one.nearListPrice},"priceUpdatedAt":"2026-11-07T10:00:00.000Z"},{"assetId":"nep141:usdt.tether-token.near","decimals":6,"blockchain":"near","symbol":"USDT","price":0.999046}]`,
        { status: 200 },
      );
    }
    if (path === "/v0/quote") {
      if (one.quoteReject) return reply(400, { message: one.quoteReject });
      one.deposits += 1;
      const exactOut = body.swapType === "EXACT_OUTPUT";
      const amount = BigInt(body.amount);
      // A NEAR payout is delivered in yocto: what the treasury spends in USDC units is the NEAR
      // amount at the quote price, plus the same small fee as any payout.
      const nearOut = exactOut && body.destinationAsset === "nep141:wrap.near";
      const priceDigits = one.nearQuotePrice.split(".")[1]?.length ?? 0;
      const nearSpend = nearOut
        ? (amount * BigInt(one.nearQuotePrice.replace(".", ""))) /
          10n ** BigInt(24 - 6 + priceDigits)
        : amount;
      const quote = exactOut
        ? {
            amountIn: (nearSpend + 2900n).toString(),
            minAmountIn: (nearSpend + 2400n).toString(),
            amountOut: body.amount,
            minAmountOut: body.amount,
            withdrawFee: "2400",
            ...(body.dry
              ? {}
              : {
                  deadline: "2026-11-09T00:15:00.000Z",
                  depositAddress: `payout-${randomBytes(16).toString("hex")}`,
                }),
          }
        : {
            amountIn: body.amount,
            amountInFormatted: body.amount === "300000" ? "0.3" : body.amount,
            minAmountIn: body.amount,
            amountOut: "1997841",
            minAmountOut: "1977862",
            withdrawFee: "0",
            ...(body.dry
              ? {}
              : {
                  deadline: "2026-11-09T00:00:00.000Z",
                  depositAddress: `deposit-${randomBytes(16).toString("hex")}`,
                }),
          };
      if ("depositAddress" in quote && quote.depositAddress) {
        one.quotes.set(quote.depositAddress, {
          amountIn: quote.amountIn,
          depositType: body.depositType,
        });
      }
      const response = {
        quote,
        quoteRequest: { ...body, ...one.echoChange },
        timestamp: "2026-11-07T10:00:00.000Z",
        correlationId: randomBytes(8).toString("hex"),
      };
      return reply(201, { ...response, signature: one.signer(response) });
    }
    if (path === "/v0/generate-intent") {
      const tamper = one.tamperIntent as Record<string, string | undefined>;
      const q = one.quotes.get(body.depositAddress);
      const confidential = q?.depositType === "CONFIDENTIAL_INTENTS";
      const live = [...one.requests].reverse().find((r) => r.path === "/v0/quote")?.body;
      const token =
        tamper.token ??
        (confidential ? `${CONFIDENTIAL_TOKEN_PREFIX}${TREASURY_USDC}` : TREASURY_USDC);
      const amount = tamper.amount ?? (confidential ? q?.amountIn : live.amount);
      const nonce = Buffer.alloc(32);
      nonce.set([0x56, 0x28, 0xf6, 0xc6, 0], 0);
      nonce.set(Buffer.from(tamper.salt ?? one.salt, "hex"), 5);
      return reply(201, {
        intent: {
          standard: "nep413",
          payload: {
            message: JSON.stringify({
              deadline: one.messageDeadline,
              intents: [
                {
                  intent: "transfer",
                  receiver_id: tamper.receiver ?? body.depositAddress,
                  tokens: { [token]: amount },
                },
              ],
              signer_id: tamper.signer ?? body.signerId,
            }),
            nonce: randomizeTail(nonce).toString("base64"),
            recipient: tamper.recipient ?? (confidential ? "intents.far" : "intents.near"),
          },
        },
      });
    }
    if (path === "/v0/submit-intent") {
      if (body.signedData.payload.recipient === "intents.near") {
        // Shields (slice 4).
        return one.submitStatus === 201
          ? reply(201, { intentHash: "hash-sentinel", correlationId: "c" })
          : reply(one.submitStatus, {});
      }
      const mode = one.submitQueue.shift() ?? "ok";
      if (mode === "network") throw new Error("network down");
      if (mode === "5xx") return reply(503, {});
      if (mode === "expired") return reply(400, { message: "Quote has expired" });
      if (mode === "rejected") return reply(400, { message: "invalid signature" });
      const hash = createHash("sha256").update(body.signedData.signature).digest("hex");
      return reply(201, { intentHash: `ih-${hash.slice(0, 16)}`, correlationId: "c" });
    }
    if (path === "/v0/auth/authenticate") {
      return one.authStatus === 201
        ? reply(201, {
            accessToken: ACCESS_TOKEN,
            refreshToken: REFRESH_TOKEN,
            expiresIn: 900,
            refreshExpiresIn: 604800,
          })
        : reply(one.authStatus, { message: "no" });
    }
    if (path === "/v0/auth/refresh") {
      return one.refreshStatus === 201
        ? reply(201, { accessToken: "access-refreshed-sentinel", expiresIn: 900 })
        : reply(one.refreshStatus, { message: "no" });
    }
    if (path === "/v0/account/balances") {
      if (one.balancesStatus !== 200) return reply(one.balancesStatus, { message: "no" });
      return reply(200, {
        balances:
          one.privateBalance === null
            ? []
            : [{ tokenId: TREASURY_USDC, available: one.privateBalance, source: "private" }],
      });
    }
    if (path.startsWith("/v0/status")) {
      if (one.statusHttp !== 200) return reply(one.statusHttp, {});
      const address = decodeURIComponent(path.split("depositAddress=")[1] ?? "");
      const queue = one.statusByDeposit.get(address);
      const status = queue?.length
        ? queue.length > 1
          ? (queue.shift() as string)
          : (queue[0] as string)
        : (one.statuses.shift() ?? "PENDING_DEPOSIT");
      const settled = ["SUCCESS", "REFUNDED", "FAILED", "PROCESSING"].includes(status);
      return reply(200, {
        status,
        updatedAt: "2026-11-07T10:00:00.000Z",
        swapDetails: {
          intentHashes: settled ? ["sh-1"] : [],
          nearTxHashes: settled ? ["nt-1"] : [],
          destinationChainTxHashes:
            status === "SUCCESS" ? [{ hash: "0xdest", explorerUrl: "" }] : [],
          refundedAmount: one.refundedAmount,
        },
      });
    }
    throw new Error(`unexpected 1Click path ${path}`);
  }) as unknown as typeof globalThis.fetch;

  const fakeFetch = (async (_url: string, init: RequestInit) => {
    rpcHooks.calls += 1;
    if (rpcHooks.fail) throw new Error("rpc down");
    await rpcHooks.before?.();
    const { params } = JSON.parse(init.body as string);
    if (params.request_type === "call_function") {
      if (params.method_name === "current_salt") one.saltReads.push(params.account_id);
      const value = params.method_name === "current_salt" ? one.salt : one.publicBalance;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "veylo",
          result: { logs: [], result: [...Buffer.from(JSON.stringify(value))] },
        }),
      );
    }
    if (params.request_type === "view_account") {
      // Both shapes as seen live on rpc.fastnear.com.
      const body = chain.has(params.account_id)
        ? { result: { amount: "1", block_hash: "h", block_height: 1, locked: "0" } }
        : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "veylo", ...body }));
    }
    const permission = chain.get(params.account_id)?.get(params.public_key);
    const result =
      permission === undefined
        ? { error: `access key ${params.public_key} does not exist while viewing`, logs: [] }
        : { block_hash: "h", block_height: 1, nonce: 1, permission };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "veylo", result }));
  }) as unknown as typeof globalThis.fetch;

  const accepted = fixtureResponse("accepted");
  const quote = {
    accepted,
    rejected: fixtureResponse("recipient-rejected"),
    respond: accepted as () => Promise<Response>,
    requests: [] as Record<string, unknown>[],
    headers: [] as Record<string, string>[],
  };
  const quoteFetch = (async (_url: string, init: RequestInit) => {
    quote.requests.push(JSON.parse(init.body as string));
    quote.headers.push(init.headers as Record<string, string>);
    return quote.respond();
  }) as unknown as typeof globalThis.fetch;

  const rpc = createNearRpc({ url: "https://rpc.invalid", fetch: fakeFetch });
  const treasuryClient = createOneClickTreasuryClient({
    apiKey: QUOTE_KEY,
    fetch: oneFetch,
    quotePublicKey: QUOTE_SIGNER_PUBLIC,
  });
  const intentsReader = createIntentsReader({ url: "https://rpc.invalid", fetch: fakeFetch });
  const secrets = createSecretBox({ masterKey: MASTER_KEY, random: (n) => randomBytes(n) });

  // Every 2xx response the API sends in any test is checked against the web client's contract
  // (@veylo/contract). A mismatch becomes a 500, so the test that exercised it fails (slice W1).
  const build = async (overrides: Partial<Deps> = {}) => {
    const app = await buildUnchecked(overrides);
    app.addHook("onSend", async (request, reply, payload) => {
      if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;
      const key = `${request.method} ${request.routeOptions.url}` as RouteKey;
      const schema = ROUTES[key];
      if (schema === undefined) throw new Error(`contract: no schema for ${key}`);
      if (schema === "csv") return payload;
      const parsed = schema.safeParse(JSON.parse(String(payload)));
      if (!parsed.success) {
        const message = `contract violation on ${key}: ${parsed.error.message.slice(0, 2000)}`;
        console.error(message);
        throw new Error(message);
      }
      return payload;
    });
    return app;
  };
  const buildUnchecked = (overrides: Partial<Deps> = {}) =>
    buildServer({
      db,
      clock: () => clock.now,
      random: (bytes) => randomBytes(bytes),
      rpc,
      oneclick: createOneClickDryClient({ apiKey: QUOTE_KEY, fetch: quoteFetch }),
      oneclickTreasury: treasuryClient,
      intents: intentsReader,
      secrets,
      config: {
        authRecipient: RECIPIENT,
        webOrigin: "https://app.veylo.test",
        sessionTtlHours: 24,
        logLevel: "silent",
        // Tests keep every route covered; production uses only the enabled ones (L46).
        enabledPayoutRoutes: PAYOUT_ROUTE_IDS,
      },
      authRateLimitPerMinute: 100_000,
      ...overrides,
    });

  return {
    db,
    client,
    clock,
    chain,
    rpcHooks,
    quote,
    one,
    build,
    rpc,
    treasuryClient,
    intentsReader,
    secrets,
  };
}

export async function challenge(app: App, accountId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/challenge",
    payload: { accountId },
  });
  return res.json() as { message: string; nonce: string; recipient: string };
}

export function verify(app: App, wallet: Wallet, c: { message: string; nonce: string }) {
  return app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: {
      accountId: wallet.accountId,
      publicKey: wallet.publicKey,
      signature: wallet.sign(c.message, c.nonce, RECIPIENT),
      nonce: c.nonce,
    },
  });
}

export const sessionCookie = (res: { cookies: { name: string; value: string }[] }) => {
  const found = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!found) throw new Error("no session cookie");
  return { [SESSION_COOKIE]: found.value };
};

/** Signs in a fresh or given wallet, and returns its cookie. */
export async function signIn(app: App, wallet = new Wallet()) {
  const res = await verify(app, wallet, await challenge(app, wallet.accountId));
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.body}`);
  return { wallet, cookies: sessionCookie(res) };
}

export async function createOrg(app: App, cookies: Record<string, string>, name = "Org") {
  const res = await app.inject({ method: "POST", url: "/orgs", cookies, payload: { name } });
  if (res.statusCode !== 201) throw new Error(`createOrg failed: ${res.body}`);
  return res.json() as { id: string; name: string; treasuryAccountId: string };
}

/** Signs in a new user and adds them to the org. */
export async function addMember(
  app: App,
  ownerCookies: Record<string, string>,
  orgId: string,
  role: "owner" | "viewer" | "accountant" | "preparer",
) {
  const member = await signIn(app);
  const res = await app.inject({
    method: "POST",
    url: `/orgs/${orgId}/members`,
    cookies: ownerCookies,
    payload: { nearAccountId: member.wallet.accountId, role },
  });
  if (res.statusCode !== 201) throw new Error(`addMember failed: ${res.body}`);
  return { ...member, userId: (res.json() as { userId: string }).userId };
}
