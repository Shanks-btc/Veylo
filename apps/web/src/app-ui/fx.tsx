"use client";
// Local-currency estimates (slice W6, part 3c): display only. A rate comes from the API's one
// documented FX source and is shown beside USD as "about", with where it came from and when. It is
// never used to compute, quote, sign or settle anything: every amount that moves money is USD or
// the asset units the gates check. When no rate is available the screens say so instead of guessing.
import { estimateText } from "@veylo/core";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSession } from "./session";

type Fx =
  | { state: "loading" }
  | { state: "unavailable" }
  | {
      state: "ready";
      rates: Record<string, string>;
      source: { name: string; url: string; termsUrl: string; attribution: string };
      fetchedAt: string;
    };

const FxContext = createContext<Fx>({ state: "unavailable" });
export const useFx = () => useContext(FxContext);

export function FxProvider({ children }: { children: ReactNode }) {
  const { api, me } = useSession();
  const [fx, setFx] = useState<Fx>({ state: "loading" });
  useEffect(() => {
    if (!me) return;
    let live = true;
    api.call("GET /fx").then(
      (r) =>
        live &&
        setFx(
          r.available
            ? { state: "ready", rates: r.rates, source: r.source, fetchedAt: r.fetchedAt }
            : { state: "unavailable" },
        ),
      () => live && setFx({ state: "unavailable" }),
    );
    return () => {
      live = false;
    };
  }, [api, me]);
  const value = useMemo(() => fx, [fx]);
  return <FxContext.Provider value={value}>{children}</FxContext.Provider>;
}

/** "≈ ₦134,982.26 estimate" beside a USD amount, or a plain note when no rate is available. */
export function Estimate({
  usdUnits,
  currency,
}: {
  usdUnits: bigint | null;
  currency: string | null | undefined;
}) {
  const fx = useFx();
  if (!currency || currency === "USD" || usdUnits === null) return null;
  if (fx.state === "loading") return null;
  if (fx.state === "unavailable")
    return <span className="estimate">{currency} estimate: rate unavailable</span>;
  const text = estimateText(usdUnits, fx.rates[currency], currency);
  if (!text) return <span className="estimate">{currency} estimate: rate unavailable</span>;
  return (
    <span className="estimate" title={`${fx.source.name}, ${new Date(fx.fetchedAt).toUTCString()}`}>
      {text} estimate
    </span>
  );
}

/** The attribution the rate source asks for, once per page that shows estimates. */
export function FxNote({ currency }: { currency: string | null | undefined }) {
  const fx = useFx();
  if (!currency || currency === "USD") return null;
  return (
    <p className="page-note">
      Estimates in {currency} are for reading only. Payouts are made and recorded in USD terms.{" "}
      {fx.state === "ready" ? (
        <>
          <a href={fx.source.url} rel="noopener noreferrer" target="_blank">
            {fx.source.attribution}
          </a>
          , fetched {new Date(fx.fetchedAt).toUTCString()}.
        </>
      ) : fx.state === "unavailable" ? (
        "The exchange rate is unavailable right now."
      ) : null}
    </p>
  );
}
