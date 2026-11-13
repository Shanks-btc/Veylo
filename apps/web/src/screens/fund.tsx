"use client";
// Fund treasury (slice W6): the treasury holds USDC, so payroll doesn't change with crypto prices.
// Options, in this order: send USDC on NEAR (the default), USDT on NEAR converted to USDC, USDC from
// another chain, and NEAR converted to USDC. The conversions show "coming soon" until their spikes
// pass (VERIFICATION.md). Before any deposit address is shown, gate F checks 1Click's signature on
// the quote in this browser and compares it with what you asked for: your own treasury receives the
// funds, a refund returns to you, the amount is the amount. The address on screen is the signed one.
import {
  FUNDING_AVAILABILITY,
  FUNDING_ORIGINS,
  defineAsset,
  formatFixed,
  parseAmount,
  type FundingOriginId,
} from "@veylo/core";
import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { LoadBlock } from "../app-ui/page-kit";
import { NeedsOrg, PageHeader, ErrorNote } from "../app-ui/shell";
import { useApi, useSession } from "../app-ui/session";
import { checkFundingQuote } from "../gates/funding";
import { unitsToDecimal } from "../app-ui/format";
import { AmountText, Button, Field, fieldAria, Stat, Tag } from "../ui/basic";
import { AddressText, Card, useToast } from "../ui/interactive";
import { QrCode } from "../ui/qr";

type Origin = (typeof FUNDING_ORIGINS)[number];
const origin = (id: FundingOriginId): Origin => FUNDING_ORIGINS.find((o) => o.id === id) as Origin;

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

function Quote({
  orgId,
  served,
  asked,
}: {
  orgId: string;
  served: Served;
  asked: { origin: Origin };
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
    } catch (err) {
      toast("error", err instanceof ApiError ? err.message : "Couldn't check the status.");
    }
  }
  return (
    <Card className="stack">
      <h2 className="section-title">Send exactly this</h2>
      <div className="fund-grid">
        <QrCode value={served.depositAddress} label="QR code of the deposit address" />
        <div className="stack">
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
                  <AmountText value={unitsToDecimal(served.amountOut)} /> USDC
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
          <div className="stack">
            <span className="muted small">Deposit address (single use)</span>
            <AddressText value={served.depositAddress} label="deposit address" />
          </div>
          <p className="draft-note">
            Send only {served.asset} on {served.network}, and exactly the amount above. If something
            goes wrong it is returned to {served.refundAddress}.
            {o.verification !== "live"
              ? " This route hasn't been tested with real funds yet: start with a small amount."
              : ""}
          </p>
        </div>
      </div>
      <p className="small muted">
        Your browser checked 1Click&apos;s signature on this quote, and that the funds go to your
        own treasury, before showing you this address.
      </p>
      <div className="actions">
        <Button variant="grey" onClick={check}>
          I&apos;ve sent it: check the status
        </Button>
        {status ? <Tag tone="neutral">{status.replaceAll("_", " ")}</Tag> : null}
      </div>
    </Card>
  );
}

function FundForm({ orgId, treasury }: { orgId: string; treasury: string }) {
  const { api, now } = useSession();
  const [choice, setChoice] = useState<FundingOriginId>("usdc-near");
  const [chain, setChain] = useState<FundingOriginId>("usdc-base");
  const [amount, setAmount] = useState("");
  const [refund, setRefund] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ served: Served; origin: Origin }>();

  const selected = origin(choice === "usdc-base" ? chain : choice);
  const soon = FUNDING_AVAILABILITY[selected.id] === "coming_soon";
  const refundDefault = selected.network === "NEAR" ? treasury : "";

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

  return (
    <div className="stack">
      <Card className="stack">
        <h2 className="section-title">How do you want to add funds?</h2>
        <p className="muted">
          Your treasury is held in USDC so payroll doesn&apos;t change with crypto prices.
        </p>
        <ul className="fund-options">
          {OPTIONS.map((opt) => {
            const o = origin(opt.id);
            const isSoon = FUNDING_AVAILABILITY[o.id] === "coming_soon";
            return (
              <li
                key={opt.id}
                className="fund-option"
                aria-current={choice === opt.id ? "true" : undefined}
              >
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
                    variant={choice === opt.id ? "dark" : "grey"}
                    small
                    onClick={() => {
                      setChoice(opt.id);
                      setResult(undefined);
                      setError(undefined);
                    }}
                    aria-pressed={choice === opt.id}
                  >
                    {choice === opt.id ? "Selected" : "Choose"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {choice === "usdc-near" ? (
        <Card className="stack">
          <h3>Buy USDC on an exchange you already use</h3>
          <p className="muted">
            Withdraw it to the address we show below, on the <strong>NEAR network</strong>. Check
            that the exchange lists USDC on NEAR before you buy; if it doesn&apos;t, use another
            option.
          </p>
        </Card>
      ) : null}

      {soon ? (
        <Card className="stack">
          <h3>
            {selected.symbol === "NEAR"
              ? "NEAR converted to USDC"
              : `${selected.symbol} converted to USDC`}
            : coming soon
          </h3>
          <p className="muted">
            We&apos;ll switch this on after a small real test (spike S-
            {selected.symbol === "NEAR" ? "F2" : "FT"} in VERIFICATION.md). Until then, send USDC on
            NEAR.
          </p>
        </Card>
      ) : (
        <Card>
          <form className="form" onSubmit={onSubmit} noValidate>
            {choice === "usdc-base" ? (
              <Field id="chain" label="Which chain are you sending from?">
                <select
                  id="chain"
                  value={chain}
                  onChange={(e) => setChain(e.target.value as FundingOriginId)}
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
                hint="You can send more than once."
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
                    ? "Defaults to your treasury account."
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
              <Button type="submit" disabled={busy}>
                {busy ? "Checking the quote…" : "Show me where to send it"}
              </Button>
            </div>
            {error && !/how much/i.test(error) ? <ErrorNote error={error} /> : null}
          </form>
        </Card>
      )}

      {result ? (
        <Quote orgId={orgId} served={result.served} asked={{ origin: result.origin }} />
      ) : null}
    </div>
  );
}

function Balances({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const b = useApi(
    () => api.call("GET /orgs/:orgId/treasury/balances", { params: { orgId } }),
    [orgId],
  );
  return (
    <LoadBlock query={b} label="balances" lines={2}>
      {(d) => (
        <div className="stats">
          <Stat
            label="Private balance"
            value={
              d.confidential.available ? (
                <AmountText value={unitsToDecimal(d.confidential.amount)} />
              ) : (
                "Unavailable"
              )
            }
            note={
              d.confidential.available ? (
                <>
                  <Tag tone="private">Private</Tag> USDC
                </>
              ) : (
                d.confidential.unavailable
              )
            }
          />
          <Stat
            label="Public balance"
            value={
              d.public.available ? (
                <AmountText value={unitsToDecimal(d.public.amount)} />
              ) : (
                "Unavailable"
              )
            }
            note={d.public.available ? "USDC on NEAR Intents" : d.public.unavailable}
          />
        </div>
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
  return (
    <>
      <PageHeader eyebrow="Money" title="Fund treasury">
        Add USDC to your treasury. Your treasury is held in USDC so payroll doesn&apos;t change with
        crypto prices.
      </PageHeader>
      <Balances orgId={orgId} />
      <LoadBlock query={org} label="your organisation">
        {(o) => <FundForm orgId={orgId} treasury={o.treasuryAccountId} />}
      </LoadBlock>
    </>
  );
}
