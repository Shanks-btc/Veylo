// Browser gate results (ARCHITECTURE §6.3, L16, L28, L29, L35). Every gate fails closed: any
// failure, missing data or RPC error is FAIL. The browser enables signing only when allPassed.

export type GateName = "A" | "deadline" | "B" | "B2" | "C";

export type GateResult = {
  readonly gate: GateName;
  readonly passed: boolean;
  /** Why it failed, for the person signing. "ok" when it passed. */
  readonly reason: string;
};

export type ItemGateReport = {
  readonly itemId: string;
  readonly gates: readonly GateResult[];
  /** True only when every gate on this item passed. */
  readonly passed: boolean;
};

export type GateReport = {
  readonly items: readonly ItemGateReport[];
  /** True only when there is at least one item and every gate on every item passed. */
  readonly allPassed: boolean;
};

export const pass = (gate: GateName): GateResult => ({ gate, passed: true, reason: "ok" });
export const fail = (gate: GateName, reason: string): GateResult => ({
  gate,
  passed: false,
  reason,
});

/** A gate check that throws (bad data, RPC error, anything) is a FAIL, never a pass. */
export async function guarded(
  gate: GateName,
  check: () => GateResult | Promise<GateResult>,
): Promise<GateResult> {
  try {
    const result = await check();
    return result.gate === gate ? result : fail(gate, "internal: wrong gate result");
  } catch (err) {
    return fail(gate, `error: ${err instanceof Error ? err.message : "unknown"}`);
  }
}
