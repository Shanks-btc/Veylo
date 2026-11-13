import "../../styles/app.css";
import type { Metadata } from "next";
import { PrivacyProofView } from "../../screens/privacy-proof";
import { Logo, ButtonLink } from "../../ui/basic";

export const metadata: Metadata = {
  title: "What the public sees · Veylo",
  description:
    "The same payout, seen by a stranger on NEAR mainnet: a direct payout can be followed from treasury to recipient; a private payout can't. Checked live.",
};

export default function Page() {
  return (
    <main id="main" className="proof-page wrap">
      <header className="proof-head">
        <a href="/" aria-label="Veylo, home">
          <Logo />
        </a>
        <ButtonLink href="/app/sign-in" small>
          Open app
        </ButtonLink>
      </header>
      <h1>What the public sees</h1>
      <PrivacyProofView />
    </main>
  );
}
