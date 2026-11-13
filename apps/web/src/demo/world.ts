// The demo world (slice W5, C3): the whole app on made-up people and a recorded quote, with no
// backend, no wallet extension and no money. Built only when NEXT_PUBLIC_DEMO=1; a production
// build contains none of this (a test greps the output for the marker "veylo-demo-world").
//
// What is real: the pay run's quote is a recorded NEAR Intents quote (T5b, 2026-11-05) with NEAR
// Intents' real signature, so gate A verifies it against the pinned key right now. The payee list
// is signed by a throwaway demo key; the demo's wallet and NEAR RPC are stand-ins for that key.
// What is made up: names, the treasury's balance and the clock (set to just after the quote).
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import {
  approvalExpiry,
  canonicalPayeeRecord,
  getPayoutRoute,
  type PayeeRecord,
} from "@veylo/core";
import {
  buildApprovalMessage,
  buildHeadMessage,
  hashNep413,
  nonceSaltHex,
  payeeRecordHash,
  payeeSetHash,
} from "@veylo/intents";
import type { GateRpc } from "../gates/rpc";
import { createMemoryHighWater, type HighWaterStore } from "../gates/high-water";
import type { WalletSigner } from "../wallet/types";
import {
  DEMO_AUDIT,
  DEMO_FX,
  DEMO_MEMBERS,
  DEMO_SCHEDULE,
  DEMO_SETTINGS,
  demoImportCheck,
} from "./fixtures-w6";
import payloadFile from "./recorded/payload-t5b.json";
import quoteFile from "./recorded/quote-t5b.json";

export const DEMO_MARKER = "veylo-demo-world";

const QUOTE = quoteFile.body as unknown as {
  quote: Record<string, any>;
  quoteRequest: Record<string, any>;
  signature: string;
  timestamp: string;
};
const PAYLOAD = payloadFile.payload as { message: string; nonce: string; recipient: string };
const SALT = nonceSaltHex(PAYLOAD.nonce) as string;

/** The dev treasury that signed the recorded T5b payout (an implicit account; public data). */
export const DEMO_TREASURY = "a87a0e4f93085edbe787aa4530021045f426c8fbc500a7c1dbd729dc4f8151ce";
/** A throwaway key. It controls nothing: the demo's RPC and wallet vouch for it. */
const SECRET = new Uint8Array(32).fill(11);
const KEY = `ed25519:${base58.encode(ed25519.getPublicKey(SECRET))}`;
const AUTH = "veylo.demo";
const ATTACKER = "0x1111111111111111111111111111111111111111";

const ORG = "11111111-1111-4111-8111-111111111111";
const OPEN_RUN = "22222222-2222-4222-8222-222222222222";
const DONE_RUN = "22222222-2222-4222-8222-333333333333";
const KWAME = "33333333-3333-4333-8333-333333333333";
const ADA = "33333333-3333-4333-8333-444444444444";
const KWAME_DEST = "55555555-5555-4555-8555-555555555555";
const ADA_DEST = "55555555-5555-4555-8555-666666666666";
const ITEM_OPEN = "66666666-6666-4666-8666-666666666661";
const ITEM_HELD = "66666666-6666-4666-8666-666666666662";
const ITEM_DIRECT = "66666666-6666-4666-8666-666666666663";
const ITEM_PRIVATE = "66666666-6666-4666-8666-666666666664";
const RECIPIENT = QUOTE.quoteRequest.recipient as string;
const AT = "2026-11-05T17:30:50.957Z";

const sign = (message: string, nonce: Uint8Array) =>
  base64.encode(ed25519.sign(hashNep413({ message, nonce, recipient: AUTH }), SECRET));

const KWAME_RECORD: PayeeRecord = (() => {
  const approvedAt = new Date("2026-11-05T10:00:00.000Z");
  return {
    orgId: ORG,
    contractorId: KWAME,
    destinationId: KWAME_DEST,
    routeId: "usdc-base",
    recipient: RECIPIENT,
    recipientType: "DESTINATION_CHAIN",
    version: 1,
    approvedAt,
    expiresAt: approvalExpiry(approvedAt),
  };
})();

function registry(tampered: boolean) {
  const r = KWAME_RECORD;
  const nonce = new Uint8Array(32).fill(21);
  const message = buildApprovalMessage({
    record: r,
    contractorName: "Kwame (demo)",
    routeLabel: getPayoutRoute("usdc-base").label,
  });
  // A compromised server can't re-sign: it serves the owner's signature next to its own record.
  const served: PayeeRecord = tampered ? { ...r, recipient: ATTACKER } : r;
  const recordHash = payeeRecordHash(r);
  const headNonce = new Uint8Array(32).fill(22);
  const signedAt = new Date("2026-11-05T10:00:00.000Z");
  const headMessage = buildHeadMessage({
    orgId: ORG,
    version: 1,
    recordHashes: [recordHash],
    signedAt,
  });
  return {
    head: {
      version: 1,
      activeSetHash: payeeSetHash([recordHash]),
      ownerPublicKey: KEY,
      signature: sign(headMessage, headNonce),
      signedAt: signedAt.toISOString(),
      nonce: base64.encode(headNonce),
      message: headMessage,
      recipient: AUTH,
      recordHashes: [recordHash],
      signerAccountId: DEMO_TREASURY,
    },
    approvals: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
        destinationId: KWAME_DEST,
        version: 1,
        contractorName: "Kwame (demo)",
        ownerAccountId: DEMO_TREASURY,
        ownerPublicKey: KEY,
        signature: sign(message, nonce),
        approvedAt: r.approvedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        nonce: base64.encode(nonce),
        message,
        recipient: AUTH,
        recordHash: tampered ? payeeRecordHash(served) : recordHash,
        canonicalRecord: canonicalPayeeRecord(served),
      },
    ],
  };
}

const contractor = (id: string, name: string, payoutMode: "direct" | "private") => ({
  id,
  orgId: ORG,
  name,
  email: null,
  displayCurrency: null,
  terms: { kind: "fixed", rate: "100000", schedule: "monthly" },
  payoutMode,
  status: "active",
  createdAt: AT,
});

const destination = (
  id: string,
  contractorId: string,
  address: string,
  route: string,
  mode: "direct" | "private",
  payable: boolean,
) => ({
  id,
  contractorId,
  route,
  payoutMode: mode,
  chain: route === "usdc-base" ? "base" : "near",
  assetId: getPayoutRoute(route as never).assetId,
  address,
  status: "active",
  supersededAt: null,
  check: { status: "accepted", reason: null, checkedAt: AT },
  feePreview: null,
  receivedPublicPayout: false,
  enteredBy: "owner",
  contractorConfirmedAt: AT,
  payable,
  payableReason: payable ? "ok" : "owner_approval_required",
  warnings: [],
});

const hashes = (near: string[], delivery: string | null) => ({
  depositAddress: null,
  correlationId: null,
  intentHash: null,
  settlementIntentHashes: [] as string[],
  nearTxHashes: near,
  destinationTxHash: delivery,
});

/** Recorded Phase 2 payouts (docs/EVIDENCE.md): the demo's ledger. */
const RECORDED = [
  {
    itemId: ITEM_DIRECT,
    contractorId: KWAME,
    name: "Kwame (demo)",
    amount: "0.500000",
    deliveryFee: "0.002400",
    route: "usdc-base",
    near: [
      "12CP8DF7umwF617kdrWuk8B8rixDH8FqLpmKqfqVCZWT",
      "2M4rSw8wZCkSrwbovvewLLYjTncZbfN5CJLtK2KG4WPb",
      "7Mm6ctWXUEdAFFfbZuH8V4NNpKeggfTrQxRf1vkBKgx",
      "8rWKiadsk1Uny37EWD8UimxLcp9rPhy2TJmmKMpYGpsc",
    ],
    delivery: "0xb8f7cd70174d9c3a951f137d1de7b76e4dcfdffd1fc11c78dc290b1fc0fb4aa8",
    at: "2026-11-05T15:28:07.000Z",
  },
  {
    itemId: ITEM_PRIVATE,
    contractorId: ADA,
    name: "Ada (demo)",
    amount: "0.100000",
    deliveryFee: "0.002400",
    route: "usdc-base",
    near: [
      "4cSR3khugpY9ga2hrZyEp2yG65X8wobJt8Ftd92dvTNa",
      "NYxGcFad7j7X1hxGZDzhFNNd8QQJRVvyrtsaNTVTqep",
    ],
    delivery: "0x4bf4fa942cecd5e031288d33153698a84919cfb3b18bbb3c1423376bd39fcf85",
    at: "2026-11-05T17:31:15.000Z",
    confidential: true,
  },
] as const;

const ledgerEntry = (e: (typeof RECORDED)[number]) => ({
  kind: "payout" as const,
  id: `bbbbbbbb-bbbb-4bbb-8bbb-${e.itemId.slice(-12)}`,
  at: e.at,
  mode: "live" as const,
  simulated: false,
  label: null,
  payRunId: DONE_RUN,
  period: "2026-10",
  itemId: e.itemId,
  contractor: { id: e.contractorId, name: e.name },
  attemptNo: 1,
  status: "SUCCESS",
  failureReason: null,
  statusHistory: [{ status: "SUCCESS", at: e.at }],
  amount: e.amount,
  currency: "USDC" as const,
  paidCurrency: "USDC" as const,
  paidAmount: e.amount,
  rate: null,
  route: "confidential" in e ? "usdc-near-confidential" : e.route,
  routeLabel: getPayoutRoute(("confidential" in e ? "usdc-near-confidential" : e.route) as never)
    .label,
  chain: "confidential" in e ? "near" : "base",
  // A private payout shows no recipient and links no public transaction.
  recipient: "confidential" in e ? null : RECIPIENT,
  amountIn: null,
  minAmountIn: null,
  deliveryFee: e.deliveryFee,
  totalFee: e.deliveryFee,
  quoteAsOf: e.at,
  refundedAmount: null,
  reconciled: true,
  reconciledAt: e.at,
  balanceUnconfirmed: false,
  hashes: hashes("confidential" in e ? [] : [...e.near], "confidential" in e ? null : e.delivery),
  links: {
    intentsExplorer: null,
    nearTxs: "confidential" in e ? [] : e.near.map((h) => `https://nearblocks.io/txns/${h}`),
    destinationTx: "confidential" in e ? null : `https://basescan.org/tx/${e.delivery}`,
  },
});

export type DemoWorld = ReturnType<typeof createDemoWorld>;

export function createDemoWorld() {
  let tampered = false;
  // Signing ends in a page load (the status screen), so "signed" survives it for this tab only.
  const flag = (key: string) => {
    let value = false;
    try {
      value = globalThis.sessionStorage?.getItem(key) === "1";
    } catch {
      // No storage: the flag lives in memory only.
    }
    return {
      get: () => value,
      set: (on: boolean) => {
        value = on;
        try {
          if (on) globalThis.sessionStorage?.setItem(key, "1");
          else globalThis.sessionStorage?.removeItem(key);
        } catch {
          // No storage: the demo just restarts on reload.
        }
      },
    };
  };
  const store = flag("veylo.demo.signed");
  const session = flag("veylo.demo.signedIn");
  let signed = store.get();
  let clockStart = Date.now();
  const quoteTime = Date.parse(QUOTE.timestamp);
  /** Just after the recorded quote, ticking in real time; reset on every fresh check. */
  const now = () => new Date(quoteTime + 2 * 60_000 + (Date.now() - clockStart));

  const quoteBody = () => {
    const q = structuredClone(QUOTE);
    // A compromised server can redirect the payout in the quote it serves, but it can't re-sign it.
    if (tampered) q.quoteRequest.recipient = ATTACKER;
    return q;
  };

  const openRun = () => ({
    id: OPEN_RUN,
    period: "2026-11",
    status: signed ? "Settling" : "Signing",
    mode: "live" as const,
    simulated: false,
    label: null,
    approvedBy: null,
    readyToSign: signed ? null : ("ready_to_sign" as const),
    totals: { payoutSum: "0.100000", feeSum: "0.005882", grandTotal: "0.105882" },
    items: [
      {
        id: ITEM_OPEN,
        contractorId: KWAME,
        destinationId: KWAME_DEST,
        amount: "0.100000",
        memo: null,
        flags: [],
        blocked: false,
        feePreview: {
          fee: "0.005882",
          asOf: AT,
          amountIn: "0.105882",
          amountOut: "0.100000",
          deliveryFee: "0.002400",
          minAmountIn: "0.105882",
        },
        mode: "live" as const,
        attempt: {
          attemptNo: 1,
          status: signed ? "SUCCESS" : "QUOTED",
          failureReason: null,
          depositAddress: QUOTE.quote.depositAddress ?? null,
          requestedDeadline: QUOTE.quote.deadline ?? null,
          quoteDeadline: QUOTE.quote.deadline ?? null,
          amountIn: "0.105882",
          minAmountIn: "0.105882",
          mode: "live" as const,
        },
      },
      {
        id: ITEM_HELD,
        contractorId: ADA,
        destinationId: ADA_DEST,
        amount: "0.100000",
        memo: null,
        flags: [
          { code: "destination_not_payable", detail: "owner_approval_required", blocking: true },
        ],
        blocked: true,
        feePreview: null,
        mode: "live" as const,
        attempt: null,
      },
    ],
    funds: { checked: false as const, reason: "not checked in the demo" },
  });

  const doneRun = () => ({
    id: DONE_RUN,
    period: "2026-10",
    status: "Completed",
    mode: "live" as const,
    simulated: false,
    label: null,
    approvedBy: null,
    readyToSign: null,
    totals: { payoutSum: "0.600000", feeSum: "0.004800", grandTotal: "0.604800" },
    items: RECORDED.map((e) => ({
      id: e.itemId,
      contractorId: e.contractorId,
      destinationId: e.contractorId === KWAME ? KWAME_DEST : ADA_DEST,
      amount: e.amount,
      memo: null,
      flags: [],
      blocked: false,
      feePreview: null,
      mode: "live" as const,
      attempt: {
        attemptNo: 1,
        status: "SUCCESS",
        failureReason: null,
        depositAddress: null,
        requestedDeadline: null,
        quoteDeadline: null,
        amountIn: null,
        minAmountIn: null,
        mode: "live" as const,
      },
    })),
    funds: { checked: false as const, reason: "not checked in the demo" },
  });

  const payslip = (e: (typeof RECORDED)[number]) => {
    const l = ledgerEntry(e);
    return {
      contractor: l.contractor,
      period: l.period,
      amount: l.amount,
      currency: l.currency,
      paidCurrency: l.paidCurrency,
      paidAmount: l.paidAmount,
      rate: l.rate,
      // The live API's payslip carries the route's label, not its id.
      route: l.routeLabel,
      chain: l.chain,
      recipient: l.recipient,
      deliveryFee: l.deliveryFee,
      totalFee: l.totalFee,
      quoteAsOf: l.quoteAsOf,
      status: l.status,
      reconciled: true,
      reconciledAt: l.reconciledAt,
      refundedAmount: null,
      hashes: l.hashes,
      links: l.links,
      timestamps: l.statusHistory,
      attempts: 1,
      mode: l.mode,
      simulated: false,
      label: null,
    };
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const error = (status: number, code: string, message: string) =>
    json(status, { error: { code, message } });

  // The contractor portal in the demo is Ada (private). Opening the read-only balance session is the
  // one thing the demo lets you do there; it is remembered for this tab only.
  const portalSession = flag("veylo.demo.portalSession");
  const portalSlips = () =>
    RECORDED.filter((e) => e.contractorId === ADA).map((e) => {
      const l = ledgerEntry(e);
      return {
        itemId: l.itemId,
        payRunId: l.payRunId,
        period: l.period,
        amount: l.amount,
        currency: l.currency,
        paidCurrency: l.paidCurrency,
        paidAmount: l.paidAmount,
        rate: l.rate,
        quoteAsOf: l.quoteAsOf,
        route: l.routeLabel,
        status: l.status,
        at: l.at,
      };
    });

  const routes: [RegExp, (m: RegExpMatchArray, method: string, body: unknown) => Response][] = [
    [/^\/fx$/, () => json(200, DEMO_FX)],
    [
      /^\/orgs\/[^/]+\/settings$/,
      () =>
        json(200, {
          name: "Northwind Studio (demo)",
          treasuryAccountId: DEMO_TREASURY,
          ...DEMO_SETTINGS,
        }),
    ],
    [/\/payroll-schedule$/, () => json(200, DEMO_SCHEDULE)],
    [/\/members$/, () => json(200, { members: DEMO_MEMBERS(DEMO_TREASURY) })],
    [/\/audit$/, () => json(200, { items: DEMO_AUDIT, nextCursor: null })],
    [/\/payee-registry\/history$/, () => json(200, { versions: [registry(tampered)] })],
    [
      /\/contractors\/import$/,
      (_m, method, body) => {
        if (method !== "POST") return error(405, "METHOD", "POST only");
        const b = (body ?? {}) as { csv?: unknown; save?: unknown };
        if (b.save === true)
          return error(409, "DEMO_READ_ONLY", "The demo is read-only: nothing is saved or sent");
        return json(200, demoImportCheck(typeof b.csv === "string" ? b.csv : ""));
      },
    ],
    [/\/contractors\/[^/]+\/address-changes$/, () => json(200, { changes: [] })],
    [
      /^\/portal\/me$/,
      () =>
        json(200, {
          contractors: [
            {
              orgId: ORG,
              orgName: "Northwind Studio (demo)",
              contractorId: ADA,
              name: "Ada (demo)",
              displayCurrency: null,
              orgDisplayCurrency: DEMO_SETTINGS.displayCurrency,
            },
          ],
        }),
    ],
    [/^\/portal\/contractors\/[^/]+\/payslips$/, () => json(200, { payslips: portalSlips() })],
    [
      /^\/portal\/contractors\/[^/]+\/destinations$/,
      () =>
        json(200, {
          destinations: [
            {
              id: ADA_DEST,
              route: "usdc-near-confidential",
              address: "ada-demo.near",
              status: "active",
              checkStatus: "accepted",
            },
          ],
        }),
    ],
    [/^\/portal\/contractors\/[^/]+\/address-changes$/, () => json(200, { changes: [] })],
    [
      /^\/portal\/contractors\/[^/]+\/balance$/,
      () =>
        portalSession.get()
          ? json(200, {
              available: true,
              tokenId: "demo",
              amount: "1500000",
              source: "demo",
              asOf: AT,
            })
          : json(200, { available: false, unavailable: "needs_session", source: "demo", asOf: AT }),
    ],
    [
      /^\/portal\/contractors\/[^/]+\/session-request$/,
      (_m, method) => {
        if (method !== "POST") return error(405, "METHOD", "POST only");
        const deadline = new Date(now().getTime() + 5 * 60_000).toISOString();
        return json(201, {
          requestId: "99999999-9999-4999-8999-999999999999",
          payload: {
            message: JSON.stringify({ deadline, intents: [], signer_id: DEMO_TREASURY }),
            nonce: base64.encode(crypto.getRandomValues(new Uint8Array(32))),
            recipient: "intents.near",
          },
          summary:
            "Sign this empty intent to let Veylo read your private balance. It moves no funds and costs nothing.",
          expiresAt: deadline,
        });
      },
    ],
    [
      /^\/portal\/contractors\/[^/]+\/session-request\/[^/]+\/complete$/,
      (_m, method) => {
        if (method !== "POST") return error(405, "METHOD", "POST only");
        portalSession.set(true);
        return json(200, { status: "active" });
      },
    ],
    [
      /^\/auth\/challenge$/,
      (_m, method) => {
        if (method !== "POST") return error(405, "METHOD", "POST only");
        // The same five-line sign-in message the live API issues, with a real five-minute window.
        const issued = new Date();
        const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
        const hex = [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
        return json(200, {
          message: [
            "Sign in to Veylo",
            `Account: ${DEMO_TREASURY}`,
            `Nonce: ${hex}`,
            `Issued: ${issued.toISOString()}`,
            `Expires: ${new Date(issued.getTime() + 5 * 60_000).toISOString()}`,
          ].join("\n"),
          nonce: base64.encode(nonceBytes),
          recipient: AUTH,
        });
      },
    ],
    [
      /^\/auth\/verify$/,
      (_m, method) => {
        if (method !== "POST") return error(405, "METHOD", "POST only");
        session.set(true);
        return json(200, { accountId: DEMO_TREASURY });
      },
    ],
    [
      /^\/auth\/logout$/,
      () => {
        session.set(false);
        return json(200, { ok: true });
      },
    ],
    [
      /^\/me$/,
      () =>
        !session.get()
          ? error(401, "UNAUTHENTICATED", "Sign in")
          : json(200, {
              user: {
                id: ORG,
                nearAccountId: DEMO_TREASURY,
                email: "kelvin@northwind.example",
                emailVerified: true,
              },
              memberships: [{ orgId: ORG, orgName: "Northwind Studio (demo)", role: "owner" }],
            }),
    ],
    [
      /^\/orgs\/[^/]+$/,
      () =>
        json(200, { id: ORG, name: "Northwind Studio (demo)", treasuryAccountId: DEMO_TREASURY }),
    ],
    [
      /\/treasury\/balances$/,
      () =>
        json(200, {
          treasuryAccountId: DEMO_TREASURY,
          public: { available: true, tokenId: "demo", amount: "0", source: "demo", asOf: AT },
          confidential: {
            available: true,
            tokenId: "demo",
            amount: signed ? "20000000" : "20105882",
            source: "demo",
            asOf: AT,
          },
        }),
    ],
    [
      /\/pay-runs$/,
      () =>
        json(200, {
          payRuns: [
            {
              id: OPEN_RUN,
              period: "2026-11",
              status: signed ? "Settling" : "Signing",
              mode: "live",
              simulated: false,
              totalAmount: "0.100000",
              scheduledFor: null,
              readyForReview: false,
            },
            {
              id: DONE_RUN,
              period: "2026-10",
              status: "Completed",
              mode: "live",
              simulated: false,
              totalAmount: "0.600000",
              scheduledFor: null,
              readyForReview: false,
            },
          ],
        }),
    ],
    [
      /\/pay-runs\/([^/]+)$/,
      (m) =>
        m[1] === OPEN_RUN
          ? json(200, openRun())
          : m[1] === DONE_RUN
            ? json(200, doneRun())
            : error(404, "NOT_FOUND", "Not in the demo"),
    ],
    [/\/payee-registry$/, () => json(200, registry(tampered))],
    [
      /\/pay-runs\/[^/]+\/items\/([^/]+)\/sign-request$/,
      (m, method) => {
        if (method !== "POST") return error(405, "METHOD", "POST only");
        if (m[1] !== ITEM_OPEN) return error(409, "NOT_QUOTED", "This payout can't be signed now");
        clockStart = Date.now(); // each fresh check gets a fresh signing window
        return json(201, {
          requestId: "77777777-7777-4777-8777-777777777777",
          payload: PAYLOAD,
          expiresAt: QUOTE.quote.deadline,
          summary: "Pay 0.100000 USDC (demo)",
          gate: {
            treasuryAccountId: DEMO_TREASURY,
            quote: quoteBody(),
            payeeApproval: null,
            registryHead: null,
          },
        });
      },
    ],
    [
      /\/sign-request\/[^/]+\/complete$/,
      (_m, method) => {
        if (method !== "POST") return error(405, "METHOD", "POST only");
        signed = true;
        store.set(true);
        return json(200, {
          attemptId: "88888888-8888-4888-8888-888888888888",
          status: "SIGNED",
          submitOutcome: "demo",
          intentHash: null,
        });
      },
    ],
    [
      /\/contractors$/,
      () =>
        json(200, {
          contractors: [
            contractor(KWAME, "Kwame (demo)", "direct"),
            contractor(ADA, "Ada (demo)", "private"),
          ],
        }),
    ],
    [
      /\/contractors\/([^/]+)\/destinations$/,
      (m) =>
        json(200, {
          destinations:
            m[1] === KWAME
              ? [destination(KWAME_DEST, KWAME, RECIPIENT, "usdc-base", "direct", true)]
              : [
                  destination(
                    ADA_DEST,
                    ADA,
                    "ada-demo.near",
                    "usdc-near-confidential",
                    "private",
                    false,
                  ),
                ],
        }),
    ],
    [
      /\/contractors\/([^/]+)$/,
      (m) =>
        m[1] === KWAME
          ? json(200, contractor(KWAME, "Kwame (demo)", "direct"))
          : m[1] === ADA
            ? json(200, contractor(ADA, "Ada (demo)", "private"))
            : error(404, "NOT_FOUND", "Not in the demo"),
    ],
    [/\/ledger$/, () => json(200, { items: RECORDED.map(ledgerEntry), nextCursor: null })],
    [
      /\/items\/([^/]+)\/payslip$/,
      (m) => {
        const e = RECORDED.find((r) => r.itemId === m[1]);
        return e ? json(200, payslip(e)) : error(404, "NOT_FOUND", "Not in the demo");
      },
    ],
  ];

  // Page-state checks (slice W6): a tab can ask the demo to answer slowly (to see skeletons), to
  // fail (to see error states) or to have nothing (to see empty states). Set in sessionStorage by
  // the browser checks; a person clicking through the demo never sees it.
  const demoMode = (): string => {
    try {
      return globalThis.sessionStorage?.getItem("veylo.demo.mode") ?? "";
    } catch {
      return "";
    }
  };
  const emptyFor = (path: string): Response | undefined => {
    if (/\/contractors$/.test(path)) return json(200, { contractors: [] });
    if (/\/pay-runs$/.test(path)) return json(200, { payRuns: [] });
    if (/\/ledger$/.test(path)) return json(200, { items: [], nextCursor: null });
    if (/\/audit$/.test(path)) return json(200, { items: [], nextCursor: null });
    if (/\/payee-registry\/history$/.test(path)) return json(200, { versions: [] });
    if (/\/payee-registry$/.test(path)) return json(200, { head: null, approvals: [] });
    if (/\/destinations$/.test(path)) return json(200, { destinations: [] });
    if (/\/payslips$/.test(path)) return json(200, { payslips: [] });
    if (/\/payroll-schedule$/.test(path)) return json(200, { schedule: null, next: null });
    return undefined;
  };

  const demoFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const mode = demoMode();
    const plumbing = /^\/(auth\/|me$)/.test(path);
    if (mode === "slow" && !plumbing) await new Promise((done) => setTimeout(done, 4000));
    if (mode === "fail" && method === "GET" && !plumbing && path !== "/fx")
      return error(503, "UNAVAILABLE", "Veylo's server isn't answering right now");
    if (mode === "empty" && method === "GET") {
      const none = emptyFor(path);
      if (none) return none;
    }
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    }
    for (const [re, handle] of routes) {
      const m = path.match(re);
      if (m) return handle(m, method, body);
    }
    return error(
      method === "GET" ? 404 : 409,
      "DEMO_READ_ONLY",
      "The demo is read-only: nothing is saved or sent",
    );
  };

  const wallet: WalletSigner = {
    async connect() {
      return { accountId: DEMO_TREASURY, publicKey: KEY };
    },
    async signMessage({ message, recipient, nonce }) {
      const signature = base64.encode(
        ed25519.sign(hashNep413({ message, recipient, nonce }), SECRET),
      );
      return { accountId: DEMO_TREASURY, publicKey: KEY, signature };
    },
    async disconnect() {},
  };

  const gateRpc: GateRpc = {
    isAccountKey: async (account, key) => account === DEMO_TREASURY && key === KEY,
    hasPublicKey: async (verifier, account, key) =>
      verifier === "intents.far" && account === DEMO_TREASURY && key === KEY,
    currentSalt: async () => SALT,
  };
  const highWater: HighWaterStore = createMemoryHighWater();

  return {
    marker: DEMO_MARKER,
    fetch: demoFetch,
    wallet,
    gateRpc,
    highWater,
    now,
    authRecipient: AUTH,
    /** The compromised-server switch: swaps one payee's address for an attacker's. */
    setTampered(on: boolean) {
      tampered = on;
    },
    isTampered: () => tampered,
    isSignedIn: () => session.get(),
    attackerAddress: ATTACKER,
    ids: { ORG, OPEN_RUN, DONE_RUN, KWAME, ADA, ITEM_OPEN, ITEM_HELD, ITEM_DIRECT, ITEM_PRIVATE },
  };
}
