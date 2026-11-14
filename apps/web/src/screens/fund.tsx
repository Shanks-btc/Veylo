"use client";
// Fund treasury (slices W6, W7.3): the treasury holds USDC, so payroll doesn't change with crypto
// prices. Options, in this order: send USDC on NEAR (the default), USDT on NEAR converted to USDC,
// USDC from another chain, and NEAR converted to USDC. The conversions show "coming soon" until their
// spikes pass (VERIFICATION.md).
//
// Choosing an option opens its panel right under it, on every screen size, and scrolls to it: the
// treasury account, the steps, the amount, and (after a quote) the deposit address with its QR code
// and a copy button. Before any deposit address is shown, gate F checks 1Click's signature on the
// quote in this browser and compares it with what you asked for: your own treasury receives the
// funds, a refund returns to you, the amount is the amount. The address on screen is the signed one.
// For USDC on NEAR the panel also shows NEAR Intents' own direct deposit call (direct-deposit.ts).
import {
  FUNDING_AVAILABILITY,
  FUNDING_ORIGINS,
  defineAsset,
  formatFixed,
  parseAmount,
  type FundingOriginId,
} from "@veylo/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { BalanceStatsView } from "../app-ui/balance-stats";
import { LoadBlock } from "../app-ui/page-kit";
import { fundingStatus } from "../app-ui/plain";
import { PrivateSessionButton } from "../app-ui/private-session";
import { NeedsOrg, PageHeader, ErrorNote } from "../app-ui/shell";
import { useApi, useOrg, useSession } from "../app-ui/session";
import { checkFundingQuote } from "../gates/funding";
import { unitsToDecimal } from "../app-ui/format";
import { AmountText, Button, Field, fieldAria, Tag } from "../ui/basic";
import { Card, useToast } from "../ui/interactive";
import { prefersReducedMotion } from "../ui/motion";
import { QrCode } from "../ui/qr";
import {
  DEPOSIT_MIN_NEAR,
  INTENTS_CONTRACT,
  USDC_CONTRACT,
  USDC_STORAGE_NEAR,
  directDeposit,
} from "./direct-deposit";

type Origin = (typeof FUNDING_ORIGINS)[number];
const origin = (id: FundingOriginId): Origin => FUNDING_ORIGINS.find((o) => o.id === id) as Origin;

const DOCS_DEPOSIT =
  "https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/deposits";

const OPTIONS: readonly {
  id: FundingOriginId;
  title: string;
  blurb: string;
}[] = [
  { id: "usdc-near", title: "Send USDC on NEAR", blurb: "The simplest way. No conversion." },
  {
    id: "usdt-near",
    title: "Fund with USDT on NEAR (converted to USDC)",
    blurb: "For teams holding USDT on NEAR.",
  },
  {
    id: "usdc-base",
    title: "USDC from another chain",
    blurb: "Pick the network you hold it on. NEAR Intents converts it on the way in.",
  },
  {
    id: "near",
    title: "Fund with NEAR (converted to USDC)",
    blurb: "For teams already holding NEAR.",
  },
];
const OTHER_CHAINS: readonly FundingOriginId[] = [
  "usdc-base",
  "usdc-arbitrum",
  "usdc-solana",
  "usdt-bsc",
];

type Served = {
  eventId: string;
  depositAddress: string;
  amountToSend: string;
  amountToSendFormatted: string;
  asset: string;
  network: string;
  deadline: string;
  minimumReceived: string;
  originId: string;
  convertsToUsdc: boolean;
  amountOut: string;
  amountOutFormatted: string;
  amountInUsd: string | null;
  amountOutUsd: string | null;
  treasuryAccountId: string;
  refundAddress: string;
  signedQuote: Record<string, unknown>;
  verification: string;
};

/** USDC per whole origin unit, from the signed amounts, to six decimals. */
function rateText(amountIn: bigint, amountOut: bigint, decimals: number): string {
  return formatFixed((amountOut * 10n ** BigInt(decimals)) / amountIn, 6);
}

/** What 1Click reports for a USD figure, as a bigint with 6 decimals, or undefined. */
function usd6(text: string | null): bigint | undefined {
  if (!text || !/^\d+(\.\d+)?$/.test(text)) return undefined;
  const [w = "0", f = ""] = text.split(".");
  return BigInt(w + f.slice(0, 6).padEnd(6, "0"));
}

/** A value shown in full (so it can be checked), with a button that copies it. */
function CopyField({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <span className="muted small">{label}</span>
      <div className="copy-row">
        <span className={mono ? "copy-value mono" : "copy-value"}>{value}</span>
        <Button
          variant="grey"
          small
          aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function Quote({
  orgId,
  served,
  asked,
  onFunded,
}: {
  orgId: string;
  served: Served;
  asked: { origin: Origin };
  onFunded: () => void;
}) {
  const { api } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState<string>();
  const o = asked.origin;
  const inn = BigInt(served.amountToSend);
  const out = BigInt(served.amountOut);
  const inUsd = usd6(served.amountInUsd);
  const outUsd = usd6(served.amountOutUsd);
  const reportedFee =
    inUsd !== undefined && outUsd !== undefined && inUsd >= outUsd ? inUsd - outUsd : undefined;

  async function check() {
    try {
      const r = await api.call("POST /orgs/:orgId/treasury/events/:id/refresh", {
        params: { orgId, id: served.eventId },
      });
      setStatus(r.status);
      if (r.status === "SUCCESS") onFunded();
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Couldn't check the status.");
    }
  }
  return (
    <div className="stack fund-quote">
      <h3 className="section-title">Send exactly this</h3>
      <div className="fund-grid">
        <QrCode value={served.depositAddress} label="QR code of the deposit address" />
        <div className="stack">
          <CopyField label="Deposit address (single use)" value={served.depositAddress} />
          <dl className="kv">
            <div className="kv-row">
              <dt>You send</dt>
              <dd>
                <strong>
                  {served.amountToSendFormatted} {served.asset}
                </strong>{" "}
                on {served.network}
              </dd>
            </div>
            {o.convertsToUsdc ? (
              <>
                <div className="kv-row">
                  <dt>You receive</dt>
                  <dd>
                    about <AmountText value={unitsToDecimal(served.amountOut)} /> USDC (at least{" "}
                    <AmountText value={unitsToDecimal(served.minimumReceived)} />)
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>Rate</dt>
                  <dd>
                    1 {served.asset} = {rateText(inn, out, o.decimals)} USDC, after fees
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>Fee</dt>
                  <dd>
                    {reportedFee !== undefined ? (
                      <>
                        about <AmountText value={unitsToDecimal(reportedFee.toString())} /> USD, as
                        reported by 1Click
                      </>
                    ) : (
                      "Included in the rate above"
                    )}
                  </dd>
                </div>
              </>
            ) : (
              <div className="kv-row">
                <dt>You receive</dt>
                <dd>
                  <AmountText value={unitsToDecimal(served.amountOut)} /> USDC (at least{" "}
                  <AmountText value={unitsToDecimal(served.minimumReceived)} />)
                </dd>
              </div>
            )}
            <div className="kv-row">
              <dt>Valid until</dt>
              <dd>
                <time dateTime={served.deadline}>
                  {served.deadline.replace("T", " ").slice(0, 16)} UTC
                </time>
              </dd>
            </div>
          </dl>
        </div>
      </div>
      <ol className="fund-steps">
        <li>
          Open your exchange or NEAR wallet and choose to send <strong>{served.asset}</strong> on{" "}
          <strong>{served.network}</strong>.
        </li>
        <li>Paste the deposit address above (or scan the QR code) as the recipient.</li>
        <li>
          Send exactly{" "}
          <strong>
            {served.amountToSendFormatted} {served.asset}
          </strong>
          .
        </li>
        <li>Come back here and check the status. It usually takes about a minute.</li>
      </ol>
      <p className="draft-note">
        Send only {served.asset} on {served.network}, and exactly the amount above. If something
        goes wrong it is returned to {served.refundAddress}.
        {o.verification !== "live"
          ? " This route hasn't been tested with real funds yet: start with a small amount."
          : ""}
        {o.network === "NEAR"
          ? ` A new address has to be registered with the ${served.asset} contract once (${USDC_STORAGE_NEAR} NEAR). Exchanges and most wallets do that for you. If yours says the account isn't registered, nothing was sent: use the one-step deposit from your own NEAR account below.`
          : ""}
      </p>
      <p className="small muted">
        Your browser checked 1Click&apos;s signature on this quote, and that the funds go to your
        own treasury, before showing you this address.
      </p>
      <div className="actions">
        <Button variant="grey" onClick={check}>
          I&apos;ve sent it: check the status
        </Button>
        {status ? (
          <Tag tone={status === "SUCCESS" ? "success" : "neutral"}>{fundingStatus(status)}</Tag>
        ) : null}
      </div>
    </div>
  );
}

/**
 * NEAR Intents' own deposit call, from the account that holds the USDC (docs: DOCS_DEPOSIT). No
 * one-time address and no 1Click fee, but the call has to be signed in a wallet or the NEAR CLI that
 * can send a contract call, and the account needs NEAR for the network fee.
 */
function DirectDeposit({ treasury, units }: { treasury: string; units: bigint | undefined }) {
  const example = units === undefined;
  const call = directDeposit({ units: units ?? 1_000_000n, treasuryAccountId: treasury });
  return (
    <details className="fund-advanced">
      <summary>
        Deposit straight into NEAR Intents from your own NEAR account (no one-time address)
      </summary>
      <div className="stack">
        <p className="muted">
          This is NEAR Intents&apos; own deposit call.{" "}
          <a href={DOCS_DEPOSIT} rel="noopener noreferrer" target="_blank">
            Read how it works
          </a>
          . You sign it in a wallet or the NEAR CLI that can send a contract call. The account you
          send from must already hold the USDC and at least <strong>{DEPOSIT_MIN_NEAR} NEAR</strong>{" "}
          for the network fee: the fee is bought up front, and what isn&apos;t used comes back one
          block later.
        </p>
        <CopyField label="Token contract (USDC on NEAR)" value={USDC_CONTRACT} />
        <CopyField label="Method" value={call.method} />
        <CopyField
          label={
            example ? "Arguments (for 1 USDC; type your amount above to change it)" : "Arguments"
          }
          value={call.args}
        />
        <dl className="kv">
          <div className="kv-row">
            <dt>Attach</dt>
            <dd>
              {call.attached}, and {call.gas}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Goes to</dt>
            <dd>
              <span className="mono">{INTENTS_CONTRACT}</span>, owned by your treasury account
            </dd>
          </div>
        </dl>
        <CopyField label="The same call for the NEAR CLI" value={call.cli} />
        <CopyField label="Your treasury account (the owner of the balance)" value={treasury} />
      </div>
    </details>
  );
}

function FundForm({
  orgId,
  treasury,
  onFunded,
}: {
  orgId: string;
  treasury: string;
  onFunded: () => void;
}) {
  const { api, now, features } = useSession();
  const [choice, setChoice] = useState<FundingOriginId>("usdc-near");
  const [chain, setChain] = useState<FundingOriginId>("usdc-base");
  const [amount, setAmount] = useState("");
  const [refund, setRefund] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ served: Served; origin: Origin }>();
  const panel = useRef<HTMLDivElement>(null);
  const resultBox = useRef<HTMLDivElement>(null);
  // Bumped on every click on an option, so choosing the option that is already selected still brings
  // its panel into view (before this, "Selected" looked like it did nothing).
  const [picks, setPicks] = useState(0);

  const selected = origin(choice === "usdc-base" ? chain : choice);
  const soon = FUNDING_AVAILABILITY[selected.id] === "coming_soon";
  const refundDefault = selected.network === "NEAR" ? treasury : "";

  useEffect(() => {
    if (picks === 0) return;
    const el = panel.current;
    if (!el) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
  }, [picks]);

  useEffect(() => {
    if (!result) return;
    resultBox.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "nearest",
    });
  }, [result]);

  // The typed amount in USDC's smallest unit, when it is a valid amount, for the direct deposit call.
  const typedUnits = (() => {
    try {
      const units = parseAmount(
        amount.trim(),
        defineAsset(selected.assetId, selected.decimals),
      ).units;
      return units > 0n ? units : undefined;
    } catch {
      return undefined;
    }
  })();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setResult(undefined);
    const asset = defineAsset(selected.assetId, selected.decimals);
    let units: bigint;
    try {
      units = parseAmount(amount.trim(), asset).units;
      if (units <= 0n) throw new Error("zero");
    } catch {
      return setError(`Enter how much ${selected.symbol} you will send, such as 250 or 250.50.`);
    }
    const refundAddress = (refund.trim() || refundDefault).trim();
    if (!refundAddress)
      return setError("Enter where we should return the money if something fails.");
    setBusy(true);
    try {
      const served = (await api.call("POST /orgs/:orgId/treasury/funding-quote", {
        params: { orgId },
        body: { originRoute: selected.id, amount: units.toString(), refundAddress },
      })) as unknown as Served;
      // Gate F: nothing is shown until 1Click's signature and every signed field check out.
      const checked = checkFundingQuote({
        served: {
          signedQuote: served.signedQuote,
          depositAddress: served.depositAddress,
          amountOut: served.amountOut,
        },
        expected: {
          treasuryAccountId: treasury,
          originAssetId: selected.assetId,
          amount: units.toString(),
          refundAddress,
        },
        now: now(),
      });
      if (!checked.ok) {
        setError(
          `This quote didn't pass the check in your browser, so no address is shown: ${checked.reason}. Try again in a moment.`,
        );
        return;
      }
      setResult({ served, origin: selected });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.code === "FUNDING_NOT_ENABLED"
            ? "This option isn't available yet."
            : err.message
          : "Couldn't get a quote. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form className="form" onSubmit={onSubmit} noValidate>
      {choice === "usdc-base" ? (
        <Field id="chain" label="Which chain are you sending from?">
          <select
            id="chain"
            value={chain}
            onChange={(e) => {
              setChain(e.target.value as FundingOriginId);
              setResult(undefined);
              setError(undefined);
            }}
          >
            {OTHER_CHAINS.map((id) => (
              <option key={id} value={id}>
                {origin(id).symbol} on {origin(id).network}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className="form-row">
        <Field
          id="fund-amount"
          label={`How much ${selected.symbol} will you send?`}
          hint="You can send more than once. Try a small amount first."
          error={error && /amount|how much/i.test(error) ? error : undefined}
        >
          <input
            {...fieldAria(
              "fund-amount",
              "hint",
              error && /how much/i.test(error) ? error : undefined,
            )}
            inputMode="decimal"
            value={amount}
            maxLength={40}
            autoComplete="off"
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field
          id="fund-refund"
          label="If something fails, return it to"
          hint={
            selected.network === "NEAR"
              ? "Defaults to your treasury account. If that account has never held USDC, use the account you send from: a new account must be registered with the USDC contract before it can receive a refund."
              : `An address on ${selected.network} that you control.`
          }
        >
          <input
            {...fieldAria("fund-refund", "hint")}
            value={refund}
            placeholder={refundDefault}
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setRefund(e.target.value)}
          />
        </Field>
      </div>
      <div className="sticky-actions">
        <Button type="submit" disabled={busy || !features.fundingQuotes}>
          {busy ? "Checking the quote…" : "Get my deposit address"}
        </Button>
        {!features.fundingQuotes ? (
          <p className="small" role="status">
            Funding isn&apos;t switched on yet, so no address can be made. Nothing was sent.
          </p>
        ) : null}
      </div>
      {error && !/how much/i.test(error) ? <ErrorNote error={error} /> : null}
    </form>
  );

  /** What sits right under the selected option. */
  const panelFor = () => {
    if (soon)
      return (
        <>
          <p>
            <strong>
              {selected.symbol === "NEAR"
                ? "NEAR converted to USDC"
                : `${selected.symbol} converted to USDC`}
              : coming soon
            </strong>
          </p>
          <p className="muted">
            We&apos;ll switch this on after a small real test (spike S-
            {selected.symbol === "NEAR" ? "F2" : "FT"} in VERIFICATION.md). Until then, send USDC on
            NEAR.
          </p>
        </>
      );
    return (
      <>
        {choice === "usdc-near" ? (
          <>
            <p className="muted">
              Send USDC on the <strong>NEAR network</strong> from an exchange or any NEAR wallet.
              Veylo gives you a one-time deposit address for it, and the funds arrive in your
              treasury on NEAR Intents, usually within a minute. Check that your exchange lists USDC
              on NEAR before you buy; if it doesn&apos;t, use another option.
            </p>
            <div className="fund-treasury stack">
              <p>
                <strong>Your treasury account</strong>
              </p>
              <div className="fund-grid">
                <QrCode value={treasury} label="QR code of your treasury account" />
                <div className="stack">
                  <CopyField label="Treasury account" value={treasury} />
                  <p className="small muted">
                    This account owns your treasury balance. Don&apos;t send USDC to it directly: it
                    would stay in your wallet instead of reaching your treasury. Use the one-time
                    deposit address that you get below.
                  </p>
                </div>
              </div>
            </div>
            <ol className="fund-steps">
              <li>Enter how much USDC you will send. Try 1 USDC first.</li>
              <li>Get your one-time deposit address. Your browser checks it before showing it.</li>
              <li>Send exactly that amount of USDC to it, on the NEAR network.</li>
              <li>Check the status here. When it says Done, the funds are in your treasury.</li>
            </ol>
          </>
        ) : null}
        {form}
        <div ref={resultBox}>
          {result ? (
            <Quote
              orgId={orgId}
              served={result.served}
              asked={{ origin: result.origin }}
              onFunded={onFunded}
            />
          ) : null}
        </div>
        {choice === "usdc-near" ? <DirectDeposit treasury={treasury} units={typedUnits} /> : null}
      </>
    );
  };

  return (
    <Card className="stack">
      <h2 className="section-title">How do you want to add funds?</h2>
      <p className="muted">
        Your treasury is held in USDC so payroll doesn&apos;t change with crypto prices.
      </p>
      <ul className="fund-options">
        {OPTIONS.map((opt) => {
          const o = origin(opt.id);
          const isSoon = FUNDING_AVAILABILITY[o.id] === "coming_soon";
          const isSelected = choice === opt.id;
          return (
            <li key={opt.id} className="fund-option" aria-current={isSelected ? "true" : undefined}>
              <div className="spread">
                <strong>{opt.title}</strong>
                {isSoon ? (
                  <Tag tone="neutral">Coming soon</Tag>
                ) : opt.id === "usdc-near" ? (
                  <Tag tone="success">Recommended</Tag>
                ) : null}
              </div>
              <span className="muted small">{opt.blurb}</span>
              <div>
                <Button
                  variant={isSelected ? "dark" : "grey"}
                  small
                  onClick={() => {
                    if (!isSelected) {
                      setChoice(opt.id);
                      setResult(undefined);
                      setError(undefined);
                    }
                    setPicks((n) => n + 1);
                  }}
                  aria-pressed={isSelected}
                  aria-controls={isSelected ? "fund-panel" : undefined}
                >
                  {isSelected ? "Selected" : "Choose"}
                </Button>
              </div>
              {isSelected ? (
                <div className="fund-panel stack" id="fund-panel" ref={panel} tabIndex={-1}>
                  {panelFor()}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Balances({ orgId, version }: { orgId: string; version: number }) {
  const { api } = useSession();
  const isOwner = useOrg()?.role === "owner";
  const b = useApi(
    () => api.call("GET /orgs/:orgId/treasury/balances", { params: { orgId } }),
    [orgId, version],
  );
  return (
    <LoadBlock query={b} label="balances" lines={2}>
      {(d) => (
        <BalanceStatsView
          confidential={d.confidential}
          pub={d.public}
          isOwner={isOwner}
          connect={
            <PrivateSessionButton
              kind={{ type: "treasury", orgId }}
              onOpened={b.reload}
              label="Connect your wallet"
            />
          }
        />
      )}
    </LoadBlock>
  );
}

export function FundScreen() {
  return <NeedsOrg>{(orgId) => <FundInner orgId={orgId} />}</NeedsOrg>;
}

function FundInner({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const org = useApi(() => api.call("GET /orgs/:orgId", { params: { orgId } }), [orgId]);
  const [version, setVersion] = useState(0);
  return (
    <>
      <PageHeader eyebrow="Money" title="Fund treasury">
        Add USDC to your treasury. Your treasury is held in USDC so payroll doesn&apos;t change with
        crypto prices.
      </PageHeader>
      <Balances orgId={orgId} version={version} />
      <LoadBlock query={org} label="your organisation">
        {(o) => (
          <FundForm
            orgId={orgId}
            treasury={o.treasuryAccountId}
            onFunded={() => setVersion((v) => v + 1)}
          />
        )}
      </LoadBlock>
    </>
  );
}
