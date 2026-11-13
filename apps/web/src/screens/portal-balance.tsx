"use client";
// Portal page 4 (slice W6): the contractor's private balance and how to cash out.
// The balance is read by Veylo's server only after the contractor's own wallet opens a read-only
// session (an empty intent: gates/session.ts checks it in the browser). The session can read; it
// cannot move money. Cash-out from this page waits for a live test (spike S-P): the checks for it are
// built and tested (src/portal/cash-out.ts), and the button says so instead of pretending.
import { USDC, formatAmount, parseUnits } from "@veylo/core";
import { Estimate, FxNote } from "../app-ui/fx";
import { LinkWalletButton } from "../app-ui/link-wallet";
import { LoadBlock } from "../app-ui/page-kit";
import { PrivateSessionButton } from "../app-ui/private-session";
import { useApi, useSession } from "../app-ui/session";
import { PageHeader } from "../app-ui/shell";
import { AmountText, Button, Stat, Tag } from "../ui/basic";
import { Card } from "../ui/interactive";
import { PortalGate, PortalPage, type PortalContractor } from "./portal-kit";

const when = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

function Balance({ c, reload }: { c: PortalContractor; reload: () => void }) {
  const { api, me } = useSession();
  const q = useApi(
    () =>
      api.call("GET /portal/contractors/:contractorId/balance", {
        params: { contractorId: c.contractorId },
      }),
    [c.contractorId, me?.user.nearAccountId],
  );
  const shown = c.displayCurrency ?? c.orgDisplayCurrency;

  return (
    <>
      <PageHeader eyebrow={c.orgName} title="Balance and cash out">
        What you hold privately on NEAR Intents, and how to move it.
      </PageHeader>

      <LoadBlock query={q} label="your balance">
        {(b) =>
          b.available ? (
            <Card className="stack">
              <div className="grid-2">
                <Stat
                  label="Private balance"
                  value={
                    <AmountText
                      value={formatAmount({ asset: USDC, units: parseUnits(b.amount, USDC).units })}
                    />
                  }
                  note={
                    <>
                      <Tag tone="private">Private</Tag> confidential on NEAR Intents
                    </>
                  }
                />
                <Stat
                  label={`About, in ${shown}`}
                  value={<Estimate usdUnits={BigInt(b.amount)} currency={shown} />}
                  note="An estimate for reading only"
                />
              </div>
              <p className="small muted">
                Read from {b.source} at <time dateTime={b.asOf}>{when(b.asOf)}</time>.
              </p>
              <div className="actions">
                <Button variant="grey" small onClick={q.reload}>
                  Refresh
                </Button>
              </div>
              <FxNote currency={shown} />
            </Card>
          ) : (
            <Card className="stack">
              <h2 className="section-title">Your private balance</h2>
              {b.unavailable === "needs_session" ? (
                me?.user.nearAccountId ? (
                  <>
                    <p className="muted">
                      Veylo can show your private balance after your wallet opens a read-only
                      connection, once. You sign one empty message.
                    </p>
                    <PrivateSessionButton
                      kind={{ type: "contractor", contractorId: c.contractorId }}
                      onOpened={() => {
                        q.reload();
                        reload();
                      }}
                    />
                  </>
                ) : (
                  <>
                    <p className="muted">
                      Your private balance lives on a NEAR wallet account. Link a wallet to your
                      account to see it. Your email can&apos;t hold or move money.
                    </p>
                    <LinkWalletButton onLinked={q.reload} />
                  </>
                )
              ) : (
                <>
                  <p className="muted">
                    {b.unavailable === "oneclick_error"
                      ? "NEAR Intents didn't answer just now. Your money is not affected. Try again in a moment."
                      : "Your balance can't be shown right now. Your money is not affected."}
                  </p>
                  <div className="actions">
                    <Button variant="grey" small onClick={q.reload}>
                      Try again
                    </Button>
                  </div>
                </>
              )}
            </Card>
          )
        }
      </LoadBlock>

      <Card className="stack">
        <div className="spread">
          <h2 className="section-title">Cash out</h2>
          <Tag tone="warning">Coming soon</Tag>
        </div>
        <p>
          Your balance is yours. Veylo can read it with your permission but can&apos;t move it: only
          your wallet can.
        </p>
        <p className="muted">
          Cash-out from this page is switched on after a live test with a small amount. Until then
          your balance stays where it is and nothing is lost.
        </p>
        <h3>When you cash out</h3>
        <ul className="list-plain">
          <li>Move it in parts rather than all at once.</li>
          <li>Use a fresh address that only you control, so your payments are harder to link.</li>
          <li>Check the address twice. A payment to the wrong address can&apos;t be taken back.</li>
        </ul>
        <p className="small muted">
          Bank cash-out in local currency through licensed partners (after the hackathon).
        </p>
      </Card>
    </>
  );
}

export const PortalBalance = () => (
  <PortalPage active="/portal/balance">
    <PortalGate next="/portal/balance">
      {(c, reload) => <Balance c={c} reload={reload} />}
    </PortalGate>
  </PortalPage>
);
