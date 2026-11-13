// What a stranger can read from a NEAR transaction's public data (slice W5, C1). Pure: the
// transaction JSON goes in; which identifiers it names comes out. Function-call arguments are
// base64 on chain, so they're decoded before looking: a signed intent hides nothing from a reader.
import { base64 } from "@scure/base";

/** Every string a reader of this transaction (and its receipts) can see, lowercased. */
export function visibleText(tx: unknown): string {
  const parts: string[] = [JSON.stringify(tx)];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k === "logs" && Array.isArray(v)) {
        // Log lines (NEP-297 events) hold JSON inside a string; read them as written.
        for (const line of v) if (typeof line === "string") parts.push(line);
      } else if (k === "args" && typeof v === "string") {
        try {
          parts.push(new TextDecoder().decode(base64.decode(v)));
        } catch {
          // Not base64 text: the raw string above already holds it.
        }
      } else walk(v);
    }
  };
  walk(tx);
  return parts.join("\n").toLowerCase();
}

export type Party = "treasury" | "deposit" | "recipient";
export type Identifiers = Record<Party, string>;

/** Which of the three identifiers one transaction names. Matching is on lowercase text. */
export function mentions(tx: unknown, ids: Identifiers): Record<Party, boolean> {
  const text = visibleText(tx);
  const has = (id: string) => id.length > 0 && text.includes(id.toLowerCase());
  return { treasury: has(ids.treasury), deposit: has(ids.deposit), recipient: has(ids.recipient) };
}

/**
 * A public trail exists when the treasury is connected to the recipient through transactions that
 * name both ends of each hop: treasury and recipient in one transaction, or treasury and deposit
 * address in one, then deposit address and recipient in another.
 */
export function publicTrail(seen: readonly Record<Party, boolean>[]): {
  linked: boolean;
  via: "none" | "same transaction" | "deposit address";
} {
  if (seen.some((m) => m.treasury && m.recipient)) return { linked: true, via: "same transaction" };
  const treasuryToDeposit = seen.some((m) => m.treasury && m.deposit);
  const depositToRecipient = seen.some((m) => m.deposit && m.recipient);
  return treasuryToDeposit && depositToRecipient
    ? { linked: true, via: "deposit address" }
    : { linked: false, via: "none" };
}
