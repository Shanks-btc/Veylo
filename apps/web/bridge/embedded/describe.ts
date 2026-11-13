// What the wallet screen tells the person it is about to sign, in plain words, before the exact
// text. The text itself is always shown too: the app verifies the signature over exactly the bytes
// it sent, so this summary is a convenience and never what is trusted.
export type Description = { title: string; lines: string[] };

const USDC_ID = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

function usdc(units: string): string {
  if (!/^\d{1,30}$/.test(units)) return units;
  const padded = units.padStart(7, "0");
  return `${padded.slice(0, -6)}.${padded.slice(-6)}`;
}

export function describeMessage(message: string, recipient: string): Description {
  const first = message.split("\n")[0] ?? "";
  if (first === "Sign in to Veylo")
    return { title: "Sign in to Veylo", lines: ["This signs you in. It cannot move money."] };
  if (first === "Link this wallet to Veylo")
    return {
      title: "Link this wallet to your Veylo account",
      lines: ["This proves the wallet is yours. It cannot move money."],
    };
  if (first.startsWith("Veylo payee"))
    return { title: "Approve a payee", lines: ["You approve who your company may pay."] };
  try {
    const body = JSON.parse(message) as {
      signer_id?: string;
      deadline?: string;
      intents?: { intent?: string; receiver_id?: string; tokens?: Record<string, string> }[];
    };
    const transfers = (body.intents ?? []).filter((i) => i.intent === "transfer");
    if (transfers.length > 0) {
      const lines = transfers.map((t) => {
        const [token = "", amount = ""] = Object.entries(t.tokens ?? {})[0] ?? [];
        const isUsdc = token.includes(USDC_ID);
        return `Send ${isUsdc ? usdc(amount) + " USDC" : `${amount} of ${token}`} to ${t.receiver_id ?? "an address"}`;
      });
      if (body.deadline) lines.push(`Valid until ${body.deadline}`);
      return { title: "Approve a payout from your treasury", lines };
    }
    if ((body.intents ?? []).length === 0)
      return {
        title: "Start a balance session",
        lines: ["This lets Veylo read your balance. It cannot move money."],
      };
  } catch {
    // Not JSON: fall through to the generic description.
  }
  return { title: "Approve this request", lines: [`For ${recipient}`] };
}
