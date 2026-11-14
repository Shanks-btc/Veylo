// 4. "A month with Veylo": a vertical timeline, not a pinned stage. Each step is one self-contained
// row: a date marker, a heading, its full text and its own picture of the screen. Nothing is pinned,
// nothing moves with the scroll, nothing covers anything else, and no text is scaled or clipped; a
// row only fades in as it enters (instantly under reduced motion). Every person and amount is
// example data, and the section says so under it.
import { Picture } from "../ui/data";
import { CheckMark } from "../ui/icon";
import { Reveal } from "./reveal";

const CHAPTERS = [
  {
    dt: "NOV 1",
    h: "Kelvin funds the treasury",
    p: "He funds it with USDC on NEAR (USDT from BNB Smart Chain works too). It arrives as USDC in Northwind's treasury on NEAR Intents, ready for payroll.",
  },
  {
    dt: "NOV 4",
    h: "Ada joins and chooses private",
    p: "She accepts the invite and adds her NEAR account. Kelvin's treasury wallet signs her address onto the payee list. Nobody else can change it.",
  },
  {
    dt: "NOV 26",
    h: "Payday, checked before signing",
    p: "Quotes arrive with their fees. Kelvin's browser verifies every one. All four checks pass, so he approves each payout in his wallet, and pays no gas.",
  },
  {
    dt: "NOV 26, MOMENTS LATER",
    h: "Everyone's paid",
    p: "Ada's payout passes through the veil and isn't publicly linked to Northwind. Kwame's direct payout stays visible on the NEAR explorer, as he chose. Five payslips are ready.",
  },
] as const;

/** The example company's funding, shown as a plain amount (no counting animation). */
const FUNDED = "20,000.00";

const CHECKS = [
  "Quote signed by NEAR Intents",
  "Payee on the signed list",
  "Account key matches",
  "Amount matches exactly",
] as const;

function Top({ label, who }: { label: string; who?: "kelvin" | "ada" }) {
  return (
    <div className="tl-top">
      <span className="sl">{label}</span>
      {who === "kelvin" ? (
        <Picture
          image="kelvin"
          alt="Kelvin, the example company's founder, at his desk"
          sizes="64px"
          className="portrait"
        />
      ) : who === "ada" ? (
        <Picture
          image="ada"
          alt="Ada, an example contractor, working on a sofa"
          sizes="64px"
          className="portrait"
        />
      ) : null}
    </div>
  );
}

const VISUALS = [
  // Nov 1: the treasury is funded.
  <div key="fund" className="tl-card">
    <Top label="NOV 1 · TREASURY" who="kelvin" />
    <div className="sbig">
      <span>{FUNDED}</span> <small>USDC</small>
    </div>
    <span className="tl-sub">Northwind Studio&apos;s treasury on NEAR Intents</span>
    <div className="flowline">
      <span className="flow-node">USDC on NEAR</span>
      <span className="track" aria-hidden="true">
        <i />
      </span>
      <span className="flow-node">Treasury</span>
    </div>
  </div>,
  // Nov 4: Ada's address goes onto the signed payee list.
  <div key="join" className="tl-card">
    <Top label="NOV 4 · NEW CONTRACTOR" who="ada" />
    <div className="dcard">
      <div className="r">
        <span>Invite accepted</span>
        <span className="v-success">Ada Lovelace</span>
      </div>
    </div>
    <div className="dcard">
      <div className="r">
        <span>Payout route</span>
        <span className="v-private">Private · NEAR</span>
      </div>
      <div className="r">
        <span>Address</span>
        <span className="mono">ada-l.near</span>
      </div>
    </div>
    <div className="dcard">
      <div className="r">
        <span>Payee list</span>
        <span className="mono">v2 → v3</span>
      </div>
    </div>
    <span className="stamp-success">
      <CheckMark />
      SIGNED BY TREASURY
    </span>
  </div>,
  // Nov 26: payday, four checks, approve.
  <div key="pay" className="tl-card">
    <Top label="NOV 26 · PAYDAY" who="kelvin" />
    <div className="tl-title">5 payouts · 16,500.00 USDC</div>
    <div className="checks">
      {CHECKS.map((c) => (
        <div key={c} className="chk2">
          <span>{c}</span>
          <span className="pass">PASS</span>
        </div>
      ))}
    </div>
    <span className="sign-note">Approve payouts in wallet · no gas</span>
  </div>,
  // Nov 26, moments later: what the public ledger shows.
  <div key="settled" className="tl-card">
    <Top label="NOV 26 · SETTLED" />
    <div className="tl-title">What the public ledger shows</div>
    <div className="lanes">
      <div className="veilbar" aria-hidden="true" />
      <div className="lane">
        <span className="lane-who">Ada · private</span>
        <span className="lane-road">
          <span className="coin-run coin-run-private">
            <span className="coin coin-private">4,200.00</span>
          </span>
        </span>
      </div>
      <div className="lane">
        <span className="lane-who">Kwame · NEAR</span>
        <span className="lane-road">
          <span className="coin-run coin-run-direct">
            <span className="coin coin-direct">3,150.00</span>
          </span>
        </span>
      </div>
    </div>
    <div className="pubnote">
      <span>Private: not linked to Northwind</span>
      <span>Direct: visible on the NEAR explorer</span>
    </div>
    <div className="dcard">
      <div className="r">
        <span>Payslips created</span>
        <span className="v-success">5 of 5</span>
      </div>
    </div>
  </div>,
];

export function Story() {
  return (
    <ol className="tl">
      {CHAPTERS.map((c, i) => (
        <Reveal as="li" key={c.dt} className="tl-step">
          <span className="tl-dot" aria-hidden="true" />
          <div className="tl-text">
            <span className="dt">{c.dt}</span>
            <h3>{c.h}</h3>
            <p>{c.p}</p>
          </div>
          <div className="tl-visual">{VISUALS[i]}</div>
        </Reveal>
      ))}
    </ol>
  );
}
