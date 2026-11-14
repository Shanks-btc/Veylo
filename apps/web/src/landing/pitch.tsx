// Directly after the hero: the problem, then the solution. Plain markup (server components). The
// privacy condition stays in full wherever "private" is claimed.
import { SolidIcon } from "../ui/basic";
import { Card } from "../ui/card";
import type { IconName } from "../ui/icon";
import { Reveal } from "./reveal";

const PROBLEMS = [
  {
    icon: "users",
    h: "Everyone sees who you pay.",
    p: "Every salary payment links your company wallet to each person you pay, visible to anyone, forever.",
  },
  {
    icon: "receipt",
    h: "Everyone sees what they earn.",
    p: "Competitors, recruiters and strangers can read salaries and totals from a block explorer.",
  },
  {
    icon: "clock",
    h: "Paying abroad is slow and costly.",
    p: "Bank wires take days and charge fees on both ends; many contractors wait weeks.",
  },
] as const satisfies readonly { icon: IconName; h: string; p: string }[];

export function Problem() {
  return (
    <section id="problem" aria-labelledby="pb-h">
      <div className="wrap">
        <span className="eye">The problem</span>
        <h2 id="pb-h">Paying your team onchain puts payroll on a public explorer.</h2>
        <div className="pitch">
          {PROBLEMS.map((x) => (
            <Reveal key={x.h}>
              <Card fx>
                <SolidIcon name={x.icon} tone="indigo" />
                <h3>{x.h}</h3>
                <p>{x.p}</p>
              </Card>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const POINTS = [
  { icon: "lock", tone: "private", h: "Private by default.", p: "Confidential payouts." },
  {
    icon: "lightning",
    tone: "indigo",
    h: "Gasless and fast.",
    p: "Your team gets USDC on NEAR with no gas to pay.",
  },
  {
    icon: "shield",
    tone: "mint",
    h: "Only you can move money.",
    p: "You approve every payout in your own wallet; your browser checks every address and amount before you sign. Veylo's server can't move funds.",
  },
] as const satisfies readonly {
  icon: IconName;
  tone: "indigo" | "private" | "mint";
  h: string;
  p: string;
}[];

export const SOLUTION_CONDITION =
  "No public source we checked links a confidential payout to your company, provided the payout address has never received a public payment from you.";

export function Solution() {
  return (
    <section id="solution" aria-labelledby="sl-h">
      <div className="wrap">
        <span className="eye">The solution</span>
        <h2 id="sl-h">One private treasury that pays your whole team.</h2>
        <p className="lede">
          Veylo pays salaries from a NEAR Intents treasury in USDC on NEAR. Private payouts go
          through NEAR Confidential Intents, so they aren&apos;t publicly linked to your company.
        </p>
        <div className="pitch">
          {POINTS.map((x) => (
            <Reveal key={x.h}>
              <Card fx>
                <SolidIcon name={x.icon} tone={x.tone} />
                <h3>{x.h}</h3>
                <p>{x.p}</p>
              </Card>
            </Reveal>
          ))}
        </div>
        <p className="cond">{SOLUTION_CONDITION}</p>
      </div>
    </section>
  );
}
