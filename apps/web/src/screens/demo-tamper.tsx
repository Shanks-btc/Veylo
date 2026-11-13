"use client";
// Demo only (slice W5, C3): the "Try to redirect a payout" panel. It makes the demo's stand-in
// server swap one payee's address for an attacker's, the way a compromised server could, then
// re-runs the browser checks so you can see them refuse it. Real builds never render this.
import { useState } from "react";
import { loadDemoWorld, isDemo } from "../demo/load";
import { Button } from "../ui/basic";

export function DemoTamper({ onChange, disabled }: { onChange: () => void; disabled: boolean }) {
  const [attacked, setAttacked] = useState(false);
  if (!isDemo()) return null;
  async function toggle() {
    const world = await loadDemoWorld();
    world.setTampered(!attacked);
    setAttacked(!attacked);
    onChange();
  }
  return (
    <section className="card demo-tamper" aria-labelledby="tamper-h">
      <h2 id="tamper-h" className="section-title">
        Try to redirect a payout
      </h2>
      <p className="small muted">
        Pretend Veylo&apos;s server was hacked. It swaps Kwame&apos;s payout address for an
        attacker&apos;s, in the payee list and in the quote. Your browser checks it against what
        your treasury wallet and NEAR Intents signed.
      </p>
      <Button variant={attacked ? "grey" : "dark"} onClick={toggle} disabled={disabled}>
        {attacked ? "Undo the attack" : "Redirect Kwame's payout to an attacker"}
      </Button>
      {attacked ? (
        <p className="small" role="status">
          The attacker can't re-sign the payee list or the quote, so the checks above should fail
          and the approve button should stay locked.
        </p>
      ) : null}
    </section>
  );
}
