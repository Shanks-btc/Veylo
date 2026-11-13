// Display helpers for the app screens. Amounts stay decimal strings (no floating point).
import { addMoney, formatAmount, parseAmount, parseUnits, USDC, PAYOUT_ROUTES } from "@veylo/core";
import { Tag, type TagTone } from "../ui/basic";

export const unitsToDecimal = (units: string): string => formatAmount(parseUnits(units, USDC));

export function sumDecimals(values: readonly string[]): string {
  let total = parseAmount("0", USDC);
  for (const v of values) {
    try {
      total = addMoney(total, parseAmount(v, USDC));
    } catch {
      // A value that isn't a USDC amount is left out of the total.
    }
  }
  return formatAmount(total);
}

export function routeLabel(routeId: string | null | undefined): string {
  return PAYOUT_ROUTES.find((r) => r.id === routeId)?.label ?? "No route";
}

/** Private (amber) or direct, never colour alone: the tag says which in words. */
export function RouteTag({
  mode,
  routeId,
}: {
  mode: "private" | "direct" | null;
  routeId?: string;
}) {
  if (mode === "private") return <Tag tone="private">Private · NEAR</Tag>;
  if (mode === "direct") {
    const chain = PAYOUT_ROUTES.find((r) => r.id === routeId)?.chain;
    const name = chain === "near" ? "NEAR" : "";
    return <Tag tone="direct">{name ? `Direct · ${name}` : "Direct"}</Tag>;
  }
  return <Tag tone="neutral">No route</Tag>;
}

const ATTEMPT_TONES: Record<string, TagTone> = {
  PLANNED: "neutral",
  QUOTED: "neutral",
  SIGNED: "warning",
  SUBMITTED: "warning",
  PROCESSING: "warning",
  SUCCESS: "success",
  REFUNDED: "warning",
  FAILED: "error",
  EXPIRED: "error",
};

/** A payout attempt's state (QUOTED, SIGNED, … EXPIRED) as a tag. */
export function StateTag({ status }: { status: string | undefined }) {
  const s = status ?? "PLANNED";
  return <Tag tone={ATTEMPT_TONES[s] ?? "neutral"}>{s}</Tag>;
}

const RUN_TONES: Record<string, TagTone> = {
  Completed: "success",
  PartiallyCompleted: "warning",
  Signing: "warning",
  Settling: "warning",
};

export function RunTag({ status }: { status: string }) {
  const words = status.replace(/([a-z])([A-Z])/g, "$1 $2");
  return <Tag tone={RUN_TONES[status] ?? "neutral"}>{words}</Tag>;
}

/** Pay runs that still hold funds back because nothing is signed yet. */
export const UNSIGNED_RUN_STATUSES = ["Draft", "Prepared", "InReview", "Quoting", "Signing"];
/** Pay runs that wait on the owner. */
export const OWNER_RUN_STATUSES = ["InReview", "Quoting", "Signing"];

export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
