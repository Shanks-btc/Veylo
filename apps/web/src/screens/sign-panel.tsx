// The review screen's signing panel. Presentational: the screen passes the gate module's report,
// and `canSign` (src/signing/pay-run.ts) decides whether "Approve payouts in wallet" is enabled. A render test
// proves it stays disabled when any gate fails or is pending.
import type { GateReport } from "../gates/types";
import { canSign, checklist } from "../signing/pay-run";
import { Button } from "../ui/basic";
import { CheckList } from "../ui/data";

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function SignPanel(props: {
  report: GateReport | undefined;
  names?: ReadonlyMap<string, string>;
  checking: boolean;
  signing: boolean;
  /** Milliseconds left before the earliest quote can't be signed; undefined before checking. */
  msLeft: number | undefined;
  count: number;
  /** Warned payouts the owner hasn't ticked yet (D5). */
  unacknowledged?: number;
  progress?: string;
  onCheck: () => void;
  onSign: () => void;
}) {
  const expired = props.msLeft !== undefined && props.msLeft <= 0;
  const enabled = canSign({
    report: props.report,
    checking: props.checking,
    signing: props.signing,
    expired,
    unacknowledged: props.unacknowledged,
  });
  const items = checklist(props.report, props.names);
  return (
    <section className="sign-panel card" aria-labelledby="sign-h">
      <h2 id="sign-h" className="section-title">
        Browser checks
      </h2>
      <CheckList items={items} label="Checks before signing" />
      <div className="stack">
        <span className="stat-label">Signing closes in</span>
        <span
          className={expired ? "countdown countdown-expired" : "countdown"}
          role="timer"
          aria-live="off"
        >
          {props.msLeft === undefined ? "—" : formatCountdown(props.msLeft)}
        </span>
        {expired ? (
          <span className="small field-error-text">
            The quotes expired. Check again for new ones.
          </span>
        ) : null}
      </div>
      <Button
        variant="grey"
        onClick={props.onCheck}
        disabled={
          props.checking || props.signing || props.count === 0 || (props.unacknowledged ?? 0) > 0
        }
      >
        {props.checking ? "Checking…" : props.report ? "Check again" : "Check before signing"}
      </Button>
      <Button onClick={props.onSign} disabled={!enabled} aria-describedby="sign-note">
        {props.signing
          ? (props.progress ?? "Waiting for your wallet…")
          : "Approve payouts in wallet"}
      </Button>
      <p id="sign-note" className="small muted">
        {enabled
          ? `Review once. Approve each payout in your wallet: ${props.count} approval${props.count === 1 ? "" : "s"}, no gas.`
          : (props.unacknowledged ?? 0) > 0
            ? 'Tick "I\'ve checked this" on each warned payout first. Signing stays locked until you have, and until every check passes.'
            : "Signing stays locked until every check passes for every payout."}
      </p>
    </section>
  );
}
