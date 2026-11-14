// The hero's sample-workspace panel and the plain trust line under it (server components: plain
// markup, no script of their own; the count-up and the tilt are driven by the one CardFx island).
//
// The panel is a picture of the product with example data, labelled "Sample workspace" under it. It
// holds three cards: the treasury, a pay run, and a labelled "Contractor card" with a compact payslip
// card inside it (an <article>, not a <section>: the landing page's section padding would swell it).
// Nothing in it is clickable, so nothing in it looks clickable: the two small labels ("USDC on NEAR",
// "Private") are plain tinted badges with no border, no hover and no pointer.
//
// The trust line says only what the code backs, and its numbers are read from the code at build time,
// never typed in: the count of test transactions is the NEAR transactions in the proof cases the
// /proof page re-reads (src/proof/cases.ts), and the wallet count is the wallets the picker offers.
import { Logo } from "../ui/basic";
import { Icon } from "../ui/icon";
import { PROOF_CASES } from "../proof/cases";
import { ENABLED_WALLETS } from "../wallet/registry";

/** NEAR mainnet transactions in the recorded proof payouts, which /proof checks against NEAR itself. */
export const MAINNET_TX_COUNT = PROOF_CASES.reduce((n, c) => n + c.nearTxs.length, 0);

/** The one sentence under the hero panel. Only the transaction count is a link (to the proof page). */
export function TrustLine() {
  return (
    <p className="trust-line">
      Live on NEAR mainnet · <a href="/proof">{MAINNET_TX_COUNT} test transactions verified</a> ·{" "}
      {ENABLED_WALLETS.length} wallets · Gasless for payees
    </p>
  );
}

/** The sample company's payday (the same example people as the story below). */
export const SAMPLE_RUN = [
  { who: "Ada", route: "private", amount: "4,200.00" },
  { who: "Kwame", route: "direct", amount: "3,150.00" },
  { who: "Sofia", route: "private", amount: "3,000.00" },
  { who: "Tunde", route: "direct", amount: "2,850.00" },
  { who: "Mei", route: "private", amount: "3,300.00" },
] as const;
export const SAMPLE_RUN_TOTAL = "16,500.00";

/** The sample treasury. Available + reserved = the balance (the tests add them up in whole cents). */
export const SAMPLE_TREASURY = {
  balance: "248,420.50",
  available: "235,670.50",
  reserved: "12,750.00",
  paidThisMonth: "31,984.00",
} as const;

const PRIVATE_COUNT = SAMPLE_RUN.filter((r) => r.route === "private").length;
const DIRECT_COUNT = SAMPLE_RUN.length - PRIVATE_COUNT;

/** "248,420.50" as whole cents, "24842050": text only, never a float. */
const toCents = (amount: string) => amount.replace(/[,.]/g, "");

/** How long the balance takes to count up, and when it starts (the treasury card's entrance). */
export const COUNT_UP_DELAY_MS = 1150;

export function Preview() {
  const tiles = [
    { label: "Available", value: SAMPLE_TREASURY.available },
    { label: "Reserved for next pay run", value: SAMPLE_TREASURY.reserved },
    { label: "Paid this month", value: SAMPLE_TREASURY.paidThisMonth },
  ] as const;
  return (
    <div className="hp" role="group" aria-labelledby="hp-caption">
      <div className="hp-frame">
        <div className="hp-grid">
          <article className="hp-card hp-treasury card-fx" aria-label="Treasury">
            <span className="hp-eye">Treasury balance</span>
            <div className="hp-balance">
              <span
                className="hp-amount"
                data-count-cents={toCents(SAMPLE_TREASURY.balance)}
                data-count-delay={COUNT_UP_DELAY_MS}
              >
                <span className="hp-final">{`$${SAMPLE_TREASURY.balance}`}</span>
                <span className="hp-live" aria-hidden="true" />
              </span>
              <span className="hp-badge">USDC on NEAR</span>
            </div>
            <dl className="hp-tiles">
              {tiles.map((t) => (
                <div className="hp-tile" key={t.label}>
                  <dt>{t.label}</dt>
                  <dd>{`$${t.value}`}</dd>
                </div>
              ))}
            </dl>
            <p className="hp-foot">
              <span className="hp-shield-success">
                <Icon name="shield" size={16} />
              </span>
              Gasless for everyone · Only you can approve payouts
            </p>
            <span className="glare" aria-hidden="true" />
          </article>

          <article className="hp-card hp-run card-fx" aria-label="Pay run">
            <span className="hp-eye">Pay run · November</span>
            <p className="hp-title">{`${SAMPLE_RUN.length} people paid · $${SAMPLE_RUN_TOTAL}`}</p>
            <p className="hp-line">
              {`${PRIVATE_COUNT} private · ${DIRECT_COUNT} direct · approved in your wallet`}
            </p>
            <p className="hp-status">
              <i className="hp-dot-success" aria-hidden="true" />
              Every address and amount checked in your browser
            </p>
            <span className="glare" aria-hidden="true" />
          </article>

          <article className="hp-card hp-contractor card-fx" aria-label="Contractor card">
            <span className="hp-eye">Contractor card</span>
            <article className="private-card" aria-label="Contractor payslip card">
              <div className="pc-top">
                <Logo plain />
                <span className="private-badge">Private</span>
              </div>
              <div className="pc-mid">
                <p className="pc-name">Ada L.</p>
                <p className="pc-sub">USDC on NEAR · ada-l.near</p>
              </div>
              <div className="pc-bot">
                <div>
                  <span className="pc-eye">Nov salary</span>
                  <span className="pc-amount">{`$${SAMPLE_RUN[0].amount}`}</span>
                </div>
                <span className="pc-note">Paid · not publicly linked</span>
              </div>
            </article>
            <p className="hp-note">
              Contractors see payslips and their private balance in their own portal.
            </p>
            <span className="glare" aria-hidden="true" />
          </article>
        </div>
      </div>
      <p className="hp-caption" id="hp-caption">
        Sample workspace
      </p>
    </div>
  );
}
