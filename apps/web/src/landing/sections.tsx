// Landing sections 2, 3 and 5 to 12, copy verbatim from design/reference/landing.html.
import { ButtonLink, Logo, SolidIcon } from "../ui/basic";
import { Picture } from "../ui/data";
import { Icon } from "../ui/icon";
import { Card } from "../ui/card";
import { HeroGlobe } from "./globe";
import { Preview, TrustLine } from "./hero-extras";
import { Reveal } from "./reveal";
import { Story } from "./story";

export function Hero() {
  return (
    <section className="hero" id="top" aria-labelledby="hero-h">
      <Picture image="hero" alt="" sizes="100vw" className="hero-photo" priority minWidth={768} />
      <div className="hero-wash" aria-hidden="true" />
      <HeroGlobe />
      <div className="hero-vignette" aria-hidden="true" />
      <div className="wrap">
        <h1 id="hero-h">
          Pay your team anywhere.
          <br />
          <span className="hero-private">Keep payroll private.</span>
        </h1>
        <p className="hero-lede">
          Companies pay global teams privately in USDC on NEAR. <br className="hero-br" />
          Gasless for your team.
        </p>
        <div className="cta">
          <ButtonLink href="/app/sign-up" variant="light">
            Open a treasury
          </ButtonLink>
          <a className="hero-link" href="#how">
            See how it works
            <Icon name="arrowDown" size={16} />
          </a>
        </div>
        <Preview />
        <TrustLine />
      </div>
    </section>
  );
}

export function StorySection() {
  return (
    <section id="story" aria-labelledby="sy-h" className="story-section">
      <div className="wrap">
        <span className="eye">A month with Veylo</span>
        <h2 id="sy-h">One company. One month. Everyone paid.</h2>
        <Story />
        <p className="cond">
          Example company and people. Private means no public source we checked links a confidential
          payout to the company, provided the payout address has never received a public payment
          from it.
        </p>
      </div>
    </section>
  );
}

export function Features() {
  return (
    <section id="product" aria-labelledby="pr-h">
      <div className="wrap">
        <h2 id="pr-h">Your people and your treasury, in one place</h2>
        <div className="three">
          <Reveal>
            <Card fx size="lg" className="feature">
              <h3>Private payroll</h3>
              <p>
                Each person picks private or direct, both on NEAR. You see which before you sign.
              </p>
              <svg viewBox="0 0 320 200" aria-hidden="true" focusable="false" className="draw">
                <rect className="svg-ink" x="30" y="80" width="80" height="36" rx="10" />
                <text className="svg-text-light" x="70" y="103" textAnchor="middle">
                  Treasury
                </text>
                <path
                  className="stroke svg-private-stroke"
                  pathLength={1}
                  d="M110 98 C170 98 170 40 230 40"
                  strokeWidth="2"
                />
                <path
                  className="stroke d2 svg-accent"
                  pathLength={1}
                  d="M110 98 L230 98"
                  strokeWidth="2"
                />
                <g className="pop">
                  <rect
                    className="svg-private-pill"
                    x="230"
                    y="26"
                    width="76"
                    height="28"
                    rx="14"
                  />
                  <text className="svg-private-text" x="268" y="44" textAnchor="middle">
                    Private
                  </text>
                  <rect className="svg-card" x="222" y="84" width="92" height="28" rx="14" />
                  <text className="svg-text" x="268" y="102" textAnchor="middle">
                    Direct · NEAR
                  </text>
                </g>
              </svg>
            </Card>
          </Reveal>
          <Reveal>
            <Card fx size="lg" className="feature">
              <h3>Checked before you sign</h3>
              <p>
                Your browser verifies the quote, your signed payee list, the account and the amount.
                Any doubt locks signing.
              </p>
              <svg viewBox="0 0 320 200" aria-hidden="true" focusable="false" className="draw">
                <rect className="svg-card" x="40" y="30" width="240" height="150" rx="18" />
                <line
                  className="stroke svg-bar"
                  pathLength={1}
                  x1="64"
                  y1="70"
                  x2="250"
                  y2="70"
                  strokeWidth="10"
                  strokeLinecap="round"
                />
                <line
                  className="stroke d2 svg-bar"
                  pathLength={1}
                  x1="64"
                  y1="100"
                  x2="220"
                  y2="100"
                  strokeWidth="10"
                  strokeLinecap="round"
                />
                <line
                  className="stroke d3 svg-bar"
                  pathLength={1}
                  x1="64"
                  y1="130"
                  x2="235"
                  y2="130"
                  strokeWidth="10"
                  strokeLinecap="round"
                />
                <path
                  className="stroke d4 svg-success-check"
                  pathLength={1}
                  d="M150 156 l12 12 l26 -28"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <g className="pop">
                  <rect className="svg-ink" x="196" y="16" width="96" height="28" rx="14" />
                  <text className="svg-text-light" x="244" y="34" textAnchor="middle">
                    4 of 4 passed
                  </text>
                </g>
              </svg>
            </Card>
          </Reveal>
          <Reveal>
            <Card fx size="lg" className="feature">
              <h3>Gasless for everyone</h3>
              <p>
                Payouts are approved with a signed intent from the treasury&apos;s NEAR Intents
                balance. Nobody you pay, and not you, needs a gas token.
              </p>
              <svg viewBox="0 0 320 200" aria-hidden="true" focusable="false" className="draw">
                <rect className="svg-ink" x="20" y="120" width="80" height="36" rx="10" />
                <text className="svg-text-light" x="60" y="143" textAnchor="middle">
                  Treasury
                </text>
                <path
                  className="stroke svg-accent"
                  pathLength={1}
                  d="M100 138 C150 138 170 138 220 138"
                  strokeWidth="2.5"
                />
                <rect className="svg-card" x="220" y="122" width="84" height="32" rx="16" />
                <text className="svg-text" x="262" y="143" textAnchor="middle">
                  Paid
                </text>
                <g className="svg-gas">
                  <path
                    className="stroke d2 svg-gas-icon"
                    pathLength={1}
                    d="M140 44 h28 v52 h-28 z M168 58 l12 8 v26 a6 6 0 0 1 -12 0"
                    strokeWidth="3"
                    strokeLinejoin="round"
                  />
                  <line
                    className="stroke d3 svg-gas-icon"
                    pathLength={1}
                    x1="132"
                    y1="104"
                    x2="188"
                    y2="36"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                  />
                </g>
                <g className="pop">
                  <rect className="svg-ink" x="118" y="164" width="84" height="26" rx="13" />
                  <text className="svg-text-light" x="160" y="181" textAnchor="middle">
                    No gas
                  </text>
                </g>
              </svg>
            </Card>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

const WHO = [
  {
    icon: "globe",
    tone: "indigo",
    h: "Remote startups",
    p: "Contractors in many countries, paid from one treasury.",
    li: [
      "Review once, approve each payout",
      "Payslips for every person",
      "CSV for your accountant",
    ],
  },
  {
    icon: "lock",
    tone: "private",
    h: "Web3 teams and DAOs",
    p: "Already paid on-chain, but tired of salaries being public.",
    li: ["Private payouts on NEAR", "Owner-signed payee list", "No gas for contributors"],
  },
  {
    icon: "robot",
    tone: "mint",
    h: "Agencies and studios",
    p: "Clients and freelancers across borders, paid from one treasury.",
    li: [
      "Freelancers in any country",
      "Private or direct, per person",
      "Payslips for every payout",
    ],
  },
] as const;

export function Who() {
  return (
    <section id="who" aria-labelledby="wh-h">
      <div className="wrap">
        <span className="eye">Who it&apos;s for</span>
        <h2 id="wh-h">Built for teams that pay people everywhere</h2>
        <div className="who">
          {WHO.map((w) => (
            <Reveal key={w.h}>
              <Card fx>
                <SolidIcon name={w.icon} tone={w.tone} />
                <h3>{w.h}</h3>
                <p>{w.p}</p>
                <ul>
                  {w.li.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </Card>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export function QuoteBand() {
  return (
    <div className="band">
      <div className="wrap">
        <figure>
          <blockquote>Your treasury signs. Your browser checks. NEAR Intents settles.</blockquote>
          <figcaption>
            <p>How Veylo works, in one line</p>
          </figcaption>
        </figure>
      </div>
    </div>
  );
}

/** The four steps, in the founder's words. Numbers come from the list position. */
export const HOW_STEPS = [
  {
    h: "Add your team",
    p: "Names, salaries in USD and payout addresses.",
  },
  {
    h: "Fund in USDC",
    p: "Send USDC on NEAR to your treasury.",
  },
  {
    h: "Review and approve",
    p: "Your browser checks every address and amount; you approve in your wallet.",
  },
  {
    h: "Paid, privately",
    p: "USDC arrives gasless; private payouts aren't publicly linked to you.",
  },
] as const;

const TRUST_DIAGRAM_LABEL =
  "Diagram: a pay run is checked against the treasury's signed payee list and NEAR Intents' signed quotes in the browser, then settles privately or directly";

export function How() {
  return (
    <section id="how" aria-labelledby="tr-h">
      <div className="wrap">
        <span className="eye">How it works</span>
        <h2 id="tr-h" className="how-h">
          Every payout passes the same path
        </h2>
        <ol className="how-steps">
          {HOW_STEPS.map((s, i) => (
            <Reveal as="li" key={s.h} className="how-step">
              <span className="how-num" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{s.h}</h3>
              <p>{s.p}</p>
            </Reveal>
          ))}
        </ol>
        <Reveal className="tree">
          <svg
            className="tree-wide"
            viewBox="0 0 960 300"
            role="img"
            aria-label={TRUST_DIAGRAM_LABEL}
          >
            <g className="node n3">
              <path className="edge" d="M380 150 C430 150 430 80 480 80" strokeWidth="1.2" />
              <path className="edge" d="M380 150 C430 150 430 220 480 220" strokeWidth="1.2" />
            </g>
            <g className="node n4">
              <path className="edge" d="M600 80 C650 80 650 150 700 150" strokeWidth="1.2" />
              <path className="edge" d="M600 220 C650 220 650 150 700 150" strokeWidth="1.2" />
            </g>
            <g className="node n2">
              <path className="flow" d="M120 150 H300" strokeWidth="2" />
            </g>
            <g className="node n5">
              <path className="flow-private" d="M800 150 C830 150 840 90 870 90" strokeWidth="2" />
              <path className="flow" d="M800 150 C830 150 840 210 870 210" strokeWidth="2" />
            </g>
            <g className="node n1">
              <circle className="node-ink" cx="110" cy="150" r="8" />
              <text x="110" y="180" textAnchor="middle">
                Treasury
              </text>
            </g>
            <g className="node n2">
              <rect className="node-ink" x="300" y="132" width="80" height="36" rx="18" />
              <text className="t-light" x="340" y="155" textAnchor="middle">
                Pay run
              </text>
            </g>
            <g className="node n3">
              <rect className="node-card" x="480" y="62" width="120" height="36" rx="18" />
              <text x="540" y="85" textAnchor="middle">
                Signed payee list
              </text>
              <rect className="node-card" x="480" y="202" width="120" height="36" rx="18" />
              <text x="540" y="225" textAnchor="middle">
                Signed quotes
              </text>
            </g>
            <g className="node n4">
              <rect className="node-check" x="700" y="132" width="100" height="36" rx="18" />
              <text x="750" y="155" textAnchor="middle">
                Browser checks
              </text>
            </g>
            <g className="node n5">
              <rect className="node-private" x="870" y="74" width="80" height="32" rx="16" />
              <text className="t-private" x="910" y="95" textAnchor="middle">
                Private
              </text>
              <rect className="node-card" x="870" y="194" width="80" height="32" rx="16" />
              <text x="910" y="215" textAnchor="middle">
                Direct
              </text>
            </g>
          </svg>
          {/* Under 900px the same path is drawn top to bottom, so every node fits the screen. */}
          <svg
            className="tree-tall"
            viewBox="0 0 240 360"
            role="img"
            aria-label={TRUST_DIAGRAM_LABEL}
          >
            <g className="node n2">
              <path className="flow" d="M120 24 V84" strokeWidth="2" />
            </g>
            <g className="node n3">
              <path className="edge" d="M120 120 C120 140 60 140 60 160" strokeWidth="1.2" />
              <path className="edge" d="M120 120 C120 140 180 140 180 160" strokeWidth="1.2" />
            </g>
            <g className="node n4">
              <path className="edge" d="M60 208 C60 228 120 228 120 248" strokeWidth="1.2" />
              <path className="edge" d="M180 208 C180 228 120 228 120 248" strokeWidth="1.2" />
            </g>
            <g className="node n5">
              <path className="flow-private" d="M120 284 C120 304 60 304 60 324" strokeWidth="2" />
              <path className="flow" d="M120 284 C120 304 180 304 180 324" strokeWidth="2" />
            </g>
            <g className="node n1">
              <circle className="node-ink" cx="120" cy="16" r="8" />
              <text x="146" y="21" textAnchor="start">
                Treasury
              </text>
            </g>
            <g className="node n2">
              <rect className="node-ink" x="70" y="84" width="100" height="36" rx="18" />
              <text className="t-light" x="120" y="107" textAnchor="middle">
                Pay run
              </text>
            </g>
            <g className="node n3">
              <rect className="node-card" x="4" y="160" width="112" height="48" rx="18" />
              <text x="60" y="180" textAnchor="middle">
                Signed
              </text>
              <text x="60" y="197" textAnchor="middle">
                payee list
              </text>
              <rect className="node-card" x="124" y="160" width="112" height="48" rx="18" />
              <text x="180" y="180" textAnchor="middle">
                Signed
              </text>
              <text x="180" y="197" textAnchor="middle">
                quotes
              </text>
            </g>
            <g className="node n4">
              <rect className="node-check" x="40" y="248" width="160" height="36" rx="18" />
              <text x="120" y="271" textAnchor="middle">
                Browser checks
              </text>
            </g>
            <g className="node n5">
              <rect className="node-private" x="10" y="324" width="100" height="32" rx="16" />
              <text className="t-private" x="60" y="345" textAnchor="middle">
                Private
              </text>
              <rect className="node-card" x="130" y="324" width="100" height="32" rx="16" />
              <text x="180" y="345" textAnchor="middle">
                Direct
              </text>
            </g>
          </svg>
        </Reveal>
      </div>
    </section>
  );
}

const FAQ = [
  {
    q: "Do my contractors need crypto experience?",
    a: "They add one NEAR account as their payout address, private or direct. They never need gas.",
  },
  {
    q: "Is private the same as anonymous?",
    a: "No. No public source we checked links a confidential payout to your company, provided the payout address has never received a public payment from you.",
  },
  {
    q: "Who holds the money?",
    a: "Your treasury account. Nothing moves unless your treasury wallet signs it.",
  },
  {
    q: "What does it cost?",
    a: "Each payout carries a route fee, shown from the signed quote before you sign. [Veylo pricing to be published.]",
  },
] as const;

export function Faq() {
  return (
    <section id="faq" aria-labelledby="fq-h">
      <div className="wrap">
        <span className="eye">Questions</span>
        <h2 id="fq-h">Common questions</h2>
        <div className="faq accordion">
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Closing() {
  return (
    <section id="start" aria-labelledby="st-h">
      <div className="wrap">
        <span className="eye">Start using Veylo</span>
        <h2 id="st-h">Run your next payroll privately</h2>
        <div className="two">
          <Card size="lg" className="closing">
            <span className="eye">App</span>
            <h3>Open a treasury</h3>
            <p>Connect your NEAR wallet, fund the treasury and approve your first contractor.</p>
            <ButtonLink href="/app/sign-in">Open the app</ButtonLink>
          </Card>
          <Card size="lg" className="closing">
            <span className="eye">Proof</span>
            <h3>Read how it&apos;s built</h3>
            <p>The architecture, the security model, and every mainnet transaction we verified.</p>
            <ButtonLink href="/docs#evidence" variant="grey">
              Read the evidence
            </ButtonLink>
          </Card>
        </div>
      </div>
    </section>
  );
}

const FOOTER_COLS = [
  {
    h: "Product",
    links: [
      ["#how", "How it works"],
      ["#product", "Features"],
      ["#story", "Tour"],
      ["#faq", "FAQ"],
    ],
  },
  {
    h: "Resources",
    links: [
      ["/docs", "Docs"],
      ["/docs#evidence", "Evidence log"],
      ["/verify", "Verify a payout"],
      ["/proof", "What the public sees"],
    ],
  },
  {
    h: "Company",
    links: [
      ["/security", "Security"],
      ["/privacy", "Privacy policy"],
      ["/terms", "Terms"],
      ["/security#report", "Report a problem"],
    ],
  },
] as const;

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="ftop">
          <div className="fbrand">
            <a href="#top" aria-label="Veylo, back to top">
              <Logo />
            </a>
            <p>
              Private borderless payroll on NEAR. One treasury, every payout approved in your
              wallet, no gas.
            </p>
            <ButtonLink href="#start" variant="light" small>
              Open a treasury
            </ButtonLink>
          </div>
          <div className="fcols">
            {FOOTER_COLS.map((c) => (
              <nav key={c.h} aria-labelledby={`f-${c.h}`}>
                <h2 id={`f-${c.h}`}>{c.h}</h2>
                {c.links.map(([href, label]) => (
                  <a key={label} href={href}>
                    {label}
                  </a>
                ))}
              </nav>
            ))}
          </div>
        </div>
        <div className="fbot">
          <span>© 2026 Veylo. Example data shown on this page.</span>
          <span className="soc">
            <a
              href="https://github.com/Shanks-btc/Veylo"
              rel="noopener noreferrer"
              target="_blank"
              aria-label="Veylo on GitHub"
            >
              <Icon name="github" size={18} />
            </a>
          </span>
          <span>Built on NEAR Intents</span>
        </div>
      </div>
    </footer>
  );
}
