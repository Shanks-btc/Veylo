// Docs (slice W6): how to use Veylo, written for a bookkeeper or a finance lead. Plain words, no
// jargon without a sentence of explanation. What is not live yet says "coming soon" and why.
import { ENABLED_WALLETS } from "../wallet/registry";
import { PRIVACY_CONDITION } from "../site";
import { Table } from "../ui/data";
import { PublicFrame, REPO_URL } from "./public-frame";

const TOC = [
  { id: "what", label: "What Veylo does" },
  { id: "start", label: "Get started" },
  { id: "wallets", label: "Wallets" },
  { id: "fund", label: "Fund the treasury" },
  { id: "contractors", label: "Contractors and approvals" },
  { id: "pay", label: "Pay your team" },
  { id: "currencies", label: "Currencies" },
  { id: "private", label: "Private or direct" },
  { id: "statuses", label: "Payout statuses" },
  { id: "records", label: "Payslips, statements and CSV" },
  { id: "portal", label: "For contractors" },
  { id: "evidence", label: "Evidence" },
  { id: "faq", label: "Questions" },
] as const;

const STATUSES = [
  {
    s: "QUOTED",
    means: "A price is ready and waiting for your approval. Quotes expire after a few minutes.",
    todo: "Review and approve it before the countdown ends.",
  },
  { s: "SIGNED", means: "You approved it in your wallet.", todo: "Nothing. It is sent next." },
  {
    s: "SUBMITTED",
    means: "It has been sent to NEAR Intents for settlement.",
    todo: "Nothing. Wait.",
  },
  {
    s: "PROCESSING",
    means: "NEAR Intents is settling it.",
    todo: "Nothing. Wait a minute or two.",
  },
  { s: "SUCCESS", means: "The contractor has been paid.", todo: "Nothing. The payslip is ready." },
  {
    s: "REFUNDED",
    means: "It could not be delivered, and the money went back to your treasury.",
    todo: "Check the contractor's address, then pay again in a new pay run.",
  },
  {
    s: "FAILED",
    means: "It did not go through. Anything not delivered returns to your treasury.",
    todo: "Read the reason on the status screen, fix the cause, and retry the payout.",
  },
  {
    s: "EXPIRED",
    means: "The quote ran out before it was approved. No money moved.",
    todo: "Get a new quote and approve it in time.",
  },
] as const;

const FAQ = [
  {
    q: "Can Veylo move my money?",
    a: "No. Only your wallet can sign a payment, and Veylo's servers never hold a key. Before you approve a payout your browser checks it, and approving stays locked if anything does not match.",
  },
  {
    q: "What if I lose my wallet?",
    a: "If you made a Veylo wallet, only you hold its key. If you lose this device and your recovery phrase, Veylo cannot recover it. Save the recovery phrase when you are shown it, in a place only you can reach. If you connected an existing NEAR wallet, recover it the way that wallet says.",
  },
  {
    q: "Does resetting my email password give me my wallet back?",
    a: "No. Your email is for signing in and notices. It cannot sign anything and it cannot unlock a wallet. A password reset never restores a wallet.",
  },
  {
    q: "Do I need a gas token?",
    a: "No. Payouts are paid by a signed message that NEAR Intents settles, so neither you nor the people you pay need to hold a gas token.",
  },
  {
    q: "Can I pay someone's bank account?",
    a: "Not today. Payouts go to NEAR accounts in USDC (or NEAR, once that has had its live test). Amounts can be shown in a local currency for reading only. Bank cash-out in local currency through licensed partners is planned for after the hackathon.",
  },
];

export function DocsPage() {
  const wallets = ENABLED_WALLETS.map((w) => w.name);
  return (
    <PublicFrame
      title="Docs"
      lede="How to run payroll on Veylo, step by step. Written for a bookkeeper or a finance lead."
      toc={TOC}
    >
      <section id="what" aria-labelledby="what-h">
        <h2 id="what-h">What Veylo does</h2>
        <p>
          Veylo pays your contractors in USDC from one treasury on NEAR. Each person chooses to be
          paid privately or directly. Nobody needs a gas token. Every payout is checked in your
          browser before you approve it, and every payout gets a payslip and a line in your CSV
          export.
        </p>
      </section>

      <section id="start" aria-labelledby="start-h">
        <h2 id="start-h">Get started</h2>
        <ol>
          <li>
            <strong>Sign up with your email.</strong> Your email is for signing in and notices. It
            cannot sign or approve payments.
          </li>
          <li>
            <strong>Create your wallet.</strong> Choose a passkey (or a password for the wallet).
            Veylo shows a recovery phrase once. Write it down and confirm it; the wallet is not
            usable until you do.
          </li>
          <li>
            <strong>Fund the treasury with USDC on NEAR.</strong> Send USDC to the address and QR
            code on the Fund screen.
          </li>
          <li>
            <strong>Add your first contractor</strong> with a name, a monthly pay in US dollars and
            their NEAR account.
          </li>
          <li>
            <strong>Pay them.</strong> Open a pay run, check it, and approve each payout in your
            wallet.
          </li>
        </ol>
        <p>
          Already have a NEAR wallet? You can skip the email and connect it instead. Either way,
          only the wallet signs.
        </p>
      </section>

      <section id="wallets" aria-labelledby="wallets-h">
        <h2 id="wallets-h">Wallets</h2>
        <p>
          You can make a Veylo wallet in seconds, with no app to install. Only you hold its key. If
          you lose this device and your recovery phrase, Veylo cannot recover it.
        </p>
        <p>
          You can also connect an existing NEAR wallet. These are the wallets that passed
          Veylo&apos;s checks (they can sign a message the way NEAR&apos;s NEP-413 describes, and
          the code each one runs is pinned by its SHA-256):
        </p>
        <ul className="list-plain">
          {wallets.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <p>
          Whichever wallet you use, Veylo&apos;s app verifies the signature, the key and the account
          itself, every time. The list of wallets that were left out, and why, is in{" "}
          <a
            href={`${REPO_URL}/blob/main/docs/WALLETS.md`}
            rel="noopener noreferrer"
            target="_blank"
          >
            docs/WALLETS.md
          </a>
          .
        </p>
      </section>

      <section id="fund" aria-labelledby="fund-h">
        <h2 id="fund-h">Fund the treasury</h2>
        <p>
          Your treasury is held in USDC, so payroll does not change with crypto prices. The Fund
          screen shows these options in this order:
        </p>
        <ol>
          <li>
            <strong>USDC on NEAR.</strong> Send USDC to the treasury address on the NEAR network. If
            you buy USDC on an exchange, withdraw it to that address and choose the NEAR network.
            Check the network before you confirm.
          </li>
          <li>
            <strong>Fund with USDT on NEAR (converted to USDC).</strong> Coming soon. It is waiting
            for a live test.
          </li>
          <li>
            <strong>USDC from another chain.</strong> NEAR Intents converts it on the way in, and
            you see the rate and fee first.
          </li>
          <li>
            <strong>Fund with NEAR (converted to USDC).</strong> Coming soon. It is waiting for a
            live test. You will see the rate, the fee and the USDC you receive before anything is
            sent.
          </li>
        </ol>
        <p>Your browser checks the quote&apos;s signature before it shows you a deposit address.</p>
      </section>

      <section id="contractors" aria-labelledby="contractors-h">
        <h2 id="contractors-h">Contractors and approvals</h2>
        <p>
          Add contractors one by one, or from a spreadsheet (Import CSV). Each one has a monthly pay
          in US dollars, a payout route, and a NEAR account to be paid to.
        </p>
        <p>
          Nobody can be paid until your treasury wallet approves their address. The approval is
          added to a signed payee list, and your browser verifies that list on NEAR itself. An
          address change asked for by a contractor waits 24 hours before it can be approved.
        </p>
      </section>

      <section id="pay" aria-labelledby="pay-h">
        <h2 id="pay-h">Pay your team</h2>
        <p>
          A pay run lists each person, amount, route and fee. You can set a schedule (monthly, or
          every two weeks) and Veylo prepares a draft three days before payday. It never quotes,
          signs or sends anything on its own.
        </p>
        <p>
          When you open a pay run, your browser checks every payout: the quote is signed by NEAR
          Intents, it pays someone on your signed list, it uses a key your treasury controls, and it
          pays exactly the right amount. If any check fails, approving is locked and the page says
          which one and why.
        </p>
      </section>

      <section id="currencies" aria-labelledby="cur-h">
        <h2 id="cur-h">Currencies</h2>
        <ul className="list-plain">
          <li>Salaries are set in US dollars.</li>
          <li>
            Contractors are paid in USDC (privately or directly). Payouts in NEAR are coming soon;
            they are quoted at the time of payout, and you see the rate, the fee and the NEAR amount
            before you approve.
          </li>
          <li>
            Amounts can be shown beside a local currency such as NGN, EUR, GBP, KES or INR. These
            are estimates for reading only. They are never used to work out, sign or send a payment.
          </li>
          <li>Bank cash-out in local currency through licensed partners (after the hackathon).</li>
        </ul>
      </section>

      <section id="private" aria-labelledby="private-h">
        <h2 id="private-h">Private or direct</h2>
        <ul className="list-plain">
          <li>
            <strong>Private:</strong> paid in confidential USDC on NEAR. {PRIVACY_CONDITION}
          </li>
          <li>
            <strong>Direct:</strong> paid in public USDC to a NEAR account, visible on the NEAR
            explorer. Coming soon, waiting for its live test.
          </li>
        </ul>
        <p>
          Private is not anonymous: the contractor, Veylo and the settlement service can still see
          the details. The <a href="/proof">What the public sees</a> page shows the difference live
          from NEAR.
        </p>
      </section>

      <section id="statuses" aria-labelledby="statuses-h">
        <h2 id="statuses-h">Payout statuses</h2>
        <Table
          caption="Payout statuses"
          rows={STATUSES}
          rowKey={(r) => r.s}
          columns={[
            { key: "s", label: "Status", render: (r) => <strong>{r.s}</strong> },
            { key: "means", label: "What it means", render: (r) => r.means },
            { key: "todo", label: "What to do", render: (r) => r.todo },
          ]}
        />
      </section>

      <section id="records" aria-labelledby="records-h">
        <h2 id="records-h">Payslips, statements and CSV</h2>
        <p>
          Every settled payout has a payslip (PDF) and a line in the ledger. Statements sum a month
          or a range exactly, and the CSV export gives your accountant one row per payout. The{" "}
          <a href="/verify">Verify a payout</a> page re-checks a public payout against NEAR.
        </p>
      </section>

      <section id="portal" aria-labelledby="portal-h">
        <h2 id="portal-h">For contractors</h2>
        <p>
          Open the invite link your organisation sent you. Create an account with your email (or
          connect a NEAR wallet), add the NEAR account you want to be paid to, and see your payments
          and payslips. Your private balance is read only after you sign one empty message with your
          wallet, which moves nothing. Veylo can read your balance but cannot move it.
        </p>
      </section>

      <section id="evidence" aria-labelledby="evidence-h">
        <h2 id="evidence-h">Evidence</h2>
        <p>
          The mechanisms Veylo relies on were tested on NEAR mainnet with small amounts. Every
          transaction is listed in{" "}
          <a
            href={`${REPO_URL}/blob/main/docs/EVIDENCE.md`}
            rel="noopener noreferrer"
            target="_blank"
          >
            docs/EVIDENCE.md
          </a>
          , and anyone can re-check each one against public NEAR RPC. What has not been proven yet
          is marked as not proven.
        </p>
      </section>

      <section id="faq" aria-labelledby="faq-h">
        <h2 id="faq-h">Questions</h2>
        {FAQ.map((f) => (
          <details key={f.q} className="faq-item">
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </section>
    </PublicFrame>
  );
}
