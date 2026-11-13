// What the pay run status screen shows for each payout's transaction (slice W3): a direct payout
// links to its NEAR explorer transaction; a private payout says "Confidential", with why.
import { Tag } from "../ui/basic";

export type PayoutProof =
  { kind: "confidential" } | { kind: "link"; href: string } | { kind: "none" };

const EXPLORER = /^https:\/\/(nearblocks\.io|explorer\.near\.org|pikespeak\.ai)\//;

export function payoutProof(
  mode: "private" | "direct" | null,
  links: { destinationTx: string | null; nearTxs: readonly string[] } | undefined,
): PayoutProof {
  if (mode === "private") return { kind: "confidential" };
  const href = links?.destinationTx ?? links?.nearTxs[0];
  // Only a known NEAR explorer is linked: an API-served URL is never followed blindly.
  return href && EXPLORER.test(href) ? { kind: "link", href } : { kind: "none" };
}

export const CONFIDENTIAL_NOTE =
  "Paid from the confidential balance: there's no public transaction linking it to your company.";

export function ProofCell({ proof }: { proof: PayoutProof }) {
  if (proof.kind === "confidential")
    return (
      <span className="held">
        <Tag tone="private">Confidential</Tag>
        <span className="reason">{CONFIDENTIAL_NOTE}</span>
      </span>
    );
  if (proof.kind === "link")
    return (
      <a href={proof.href} target="_blank" rel="noopener noreferrer">
        View on NEAR explorer<span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  return <span className="small muted">Not settled yet</span>;
}
