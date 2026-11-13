// Security, Privacy policy and Terms (slice W6). Security and Privacy restate SECURITY.md and
// PRIVACY.md in plain words; the evidence condition is quoted verbatim wherever privacy is claimed.
// Terms is a plain-language placeholder and says so: it is not legal advice.
import { PRIVACY_CONDITION } from "../site";
import { PublicFrame, REPO_URL } from "./public-frame";

export function SecurityPage() {
  return (
    <PublicFrame
      title="Security"
      lede="What Veylo protects, how it checks, and how to tell us about a problem."
      toc={[
        { id: "model", label: "How it keeps you safe" },
        { id: "cannot", label: "What Veylo's servers cannot do" },
        { id: "wallet", label: "Your wallet" },
        { id: "report", label: "Report a vulnerability" },
      ]}
    >
      <section id="model" aria-labelledby="model-h">
        <h2 id="model-h">How it keeps you safe, in plain words</h2>
        <ul className="list-plain">
          <li>
            <strong>Who gets paid.</strong> Only your treasury wallet can add someone to your payee
            list. Your browser verifies that signed list on NEAR itself, instead of trusting
            Veylo&apos;s server.
          </li>
          <li>
            <strong>What gets paid.</strong> Before you approve a payout, your browser checks that
            the quote is signed by NEAR Intents, pays someone on your signed list, uses a key your
            treasury controls, and pays exactly the right amount. If anything does not match,
            approving is locked.
          </li>
          <li>
            <strong>Changes wait.</strong> A contractor&apos;s address change waits 24 hours before
            it can be approved, and the owner sees a warning about it.
          </li>
          <li>
            <strong>Wallet code is kept apart.</strong> Wallet code runs on a separate web address
            with no access to Veylo&apos;s servers. The app verifies every signature itself.
          </li>
        </ul>
      </section>

      <section id="cannot" aria-labelledby="cannot-h">
        <h2 id="cannot-h">What Veylo&apos;s servers cannot do</h2>
        <ul className="list-plain">
          <li>Sign a payment, or hold a key that can.</li>
          <li>Change who gets paid, or how much, without your wallet signing it.</li>
          <li>
            Unlock your wallet with your email password. Your email password and your wallet&apos;s
            protection are separate secrets that never meet.
          </li>
          <li>
            Restore a wallet after a password reset. Only your recovery phrase or a passkey you
            registered can.
          </li>
        </ul>
      </section>

      <section id="wallet" aria-labelledby="wallet-h">
        <h2 id="wallet-h">Your wallet</h2>
        <p>
          If you make a Veylo wallet, its key is created in your browser, kept encrypted on your
          device, and never sent to Veylo. Only you hold this wallet&apos;s key. If you lose this
          device and your recovery phrase, Veylo cannot recover it. You can also connect an existing
          NEAR wallet.
        </p>
      </section>

      <section id="report" aria-labelledby="report-h">
        <h2 id="report-h">Report a vulnerability</h2>
        <p>Please report security problems privately. Do not open a public issue.</p>
        <ul className="list-plain">
          <li>
            Email: <strong>security@[veylo-domain-to-be-confirmed]</strong> (a placeholder until the
            domain is confirmed).
          </li>
          <li>Include what you found, how to reproduce it, and what it affects.</li>
          <li>
            We will acknowledge your report within 3 working days and keep you updated until it is
            fixed.
          </li>
        </ul>
        <p>
          Please do not access other people&apos;s data, move funds, or disrupt the service while
          testing. Test only with accounts and funds you control. The full text is in{" "}
          <a href={`${REPO_URL}/blob/main/SECURITY.md`} rel="noopener noreferrer" target="_blank">
            SECURITY.md
          </a>
          .
        </p>
      </section>
    </PublicFrame>
  );
}

export function PrivacyPolicyPage() {
  return (
    <PublicFrame
      title="Privacy policy"
      lede="What Veylo keeps, what it does not, and what private means."
      toc={[
        { id: "private", label: "What private means" },
        { id: "keeps", label: "What Veylo keeps" },
        { id: "never", label: "What Veylo never has" },
        { id: "browser", label: "In your browser" },
      ]}
    >
      <section id="private" aria-labelledby="private-h">
        <h2 id="private-h">What private means</h2>
        <p>
          <strong>{PRIVACY_CONDITION}</strong>
        </p>
        <ul className="list-plain">
          <li>It is what we checked on mainnet, not a guarantee of anonymity.</li>
          <li>
            If the payout address has received a public payment from the company before, the two can
            be linked.
          </li>
          <li>The contractor, Veylo, and the settlement service can still see payout details.</li>
          <li>Direct payouts are public: anyone can see them on the NEAR explorer.</li>
        </ul>
      </section>

      <section id="keeps" aria-labelledby="keeps-h">
        <h2 id="keeps-h">What Veylo keeps</h2>
        <p>
          Veylo keeps the data needed to run payroll: your email address and a hash of your password
          (never the password), your organisation, contractors and their payout addresses, pay runs,
          payslips and an audit log of who did what. It never sells this data.
        </p>
        <p>
          Exchange rates for reading amounts in a local currency are fetched by Veylo&apos;s server
          from one public source. Your browser does not contact that source, and nothing about you
          is sent to it.
        </p>
      </section>

      <section id="never" aria-labelledby="never-h">
        <h2 id="never-h">What Veylo never has</h2>
        <ul className="list-plain">
          <li>Your wallet&apos;s key, or your recovery phrase.</li>
          <li>Your wallet password or passkey.</li>
          <li>The power to sign a payment for you.</li>
        </ul>
      </section>

      <section id="browser" aria-labelledby="browser-h">
        <h2 id="browser-h">In your browser</h2>
        <p>
          Your sign-in is a secure cookie. The app stores your theme and your organisation choice in
          your browser. A Veylo wallet keeps its encrypted key in your browser&apos;s storage on a
          separate web address.
        </p>
        <p>
          The full text of this policy is also in{" "}
          <a href={`${REPO_URL}/blob/main/PRIVACY.md`} rel="noopener noreferrer" target="_blank">
            PRIVACY.md
          </a>
          .
        </p>
      </section>
    </PublicFrame>
  );
}

export function TermsPage() {
  return (
    <PublicFrame
      title="Terms"
      lede="The ground rules for using Veylo, in plain language."
      toc={[
        { id: "draft", label: "Read this first" },
        { id: "service", label: "The service" },
        { id: "you", label: "Your responsibilities" },
        { id: "limits", label: "Limits" },
      ]}
    >
      <section id="draft" aria-labelledby="draft-h">
        <h2 id="draft-h">Read this first</h2>
        <p className="notice" role="note">
          Draft, not legal advice; to be reviewed by a lawyer.
        </p>
        <p>
          These terms are a plain-language placeholder for the hackathon. They are not a contract
          and have not been reviewed by a lawyer. They will be replaced before Veylo is offered to
          the public as a paid service.
        </p>
      </section>

      <section id="service" aria-labelledby="service-h">
        <h2 id="service-h">The service</h2>
        <p>
          Veylo helps you prepare, check and track payroll in USDC on NEAR. You approve every
          payment in your own wallet. Veylo does not hold your money and cannot move it.
        </p>
      </section>

      <section id="you" aria-labelledby="you-h">
        <h2 id="you-h">Your responsibilities</h2>
        <ul className="list-plain">
          <li>
            Keep your wallet, your recovery phrase and your passwords safe. Veylo cannot recover
            them.
          </li>
          <li>
            Check each contractor&apos;s address before you approve it. A payment to a wrong address
            cannot be taken back.
          </li>
          <li>
            Follow the tax, employment and payment laws that apply to you and the people you pay.
          </li>
        </ul>
      </section>

      <section id="limits" aria-labelledby="limits-h">
        <h2 id="limits-h">Limits</h2>
        <ul className="list-plain">
          <li>
            Veylo is provided as it is, during a hackathon, with no promise that it is always
            available.
          </li>
          <li>
            Amounts shown in a local currency are estimates for reading only. Payments are made and
            recorded in US dollar terms.
          </li>
          <li>Veylo does not pay bank accounts.</li>
        </ul>
      </section>
    </PublicFrame>
  );
}
