// The treasury's two balances, in plain words (W7.3), for the Treasury home and the Fund screen.
// When the private balance can't be read yet, the screen says what to do ("Connect your wallet to see
// your private balance") and offers the button that does it. A reason is never shown as a code.
import type { ReactNode } from "react";
import { unitsToDecimal } from "./format";
import { whyUnavailable } from "./plain";
import { AmountText, Stat, Tag } from "../ui/basic";
import { Card } from "../ui/interactive";

export type Reading =
  | { readonly available: true; readonly amount: string }
  | { readonly available: false; readonly unavailable: string };

/** The big number's place when there is no number: a word, not "Unavailable / needs_session". */
export const valueWhenUnavailable = (reason: string): string =>
  reason === "needs_session" ? "Not shown yet" : "Unavailable";

/**
 * Pure markup. `connect` is the button that opens the wallet session (only an owner gets one); it is
 * passed in so this view has no session of its own and can be rendered on its own in tests.
 */
export function BalanceStatsView({
  confidential,
  pub,
  connect,
  isOwner,
}: {
  confidential: Reading;
  pub: Reading;
  connect: ReactNode;
  isOwner: boolean;
}) {
  const needsSession = !confidential.available && confidential.unavailable === "needs_session";
  return (
    <div className="stack">
      {needsSession ? (
        <Card className="stack">
          <h2 className="section-title">Connect your wallet to see your private balance</h2>
          {isOwner ? (
            <>
              <p className="muted">
                Your private balance is read from NEAR Intents once your wallet opens a read-only
                connection. You sign one empty message.
              </p>
              {connect}
            </>
          ) : (
            <p className="muted">Only the owner of the treasury can connect to see this.</p>
          )}
        </Card>
      ) : null}
      <div className="grid-2">
        <Stat
          label="Private balance"
          value={
            confidential.available ? (
              <AmountText value={unitsToDecimal(confidential.amount)} />
            ) : (
              valueWhenUnavailable(confidential.unavailable)
            )
          }
          note={
            confidential.available ? (
              <>
                <Tag tone="private">Private</Tag> confidential on NEAR Intents
              </>
            ) : needsSession ? (
              "Held privately on NEAR Intents"
            ) : (
              whyUnavailable(confidential.unavailable)
            )
          }
        />
        <Stat
          label="Public balance"
          value={
            pub.available ? (
              <AmountText value={unitsToDecimal(pub.amount)} />
            ) : (
              valueWhenUnavailable(pub.unavailable)
            )
          }
          note={pub.available ? "Visible on NEAR Intents" : whyUnavailable(pub.unavailable)}
        />
      </div>
    </div>
  );
}
