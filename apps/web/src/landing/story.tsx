"use client";
// 4. "One month with Veylo": a pinned dark stage and five chapters. The chapter in the middle of the
// viewport picks the scene (IntersectionObserver). Every person and amount is example data, and the
// section says so under it. The stage repeats the chapters visually, so it's hidden from assistive
// technology; the chapters carry the same story as text.
import { useEffect, useRef, useState } from "react";
import { Picture } from "../ui/data";
import { prefersReducedMotion } from "../ui/motion";

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

const FUNDED = 20000;
const money = (v: number) =>
  v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function useCountUp(active: boolean): string {
  const [value, setValue] = useState(money(FUNDED));
  useEffect(() => {
    if (!active || prefersReducedMotion()) {
      setValue(money(FUNDED));
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 1500);
      setValue(money(FUNDED * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return value;
}

export function Story() {
  const [current, setCurrent] = useState(0);
  const chaps = useRef<(HTMLDivElement | null)[]>([]);
  const funded = useCountUp(current === 0);

  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = chaps.current.indexOf(e.target as HTMLDivElement);
          if (i >= 0) setCurrent(i);
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const c of chaps.current) if (c) io.observe(c);
    return () => io.disconnect();
  }, []);

  const on = (i: number) => (i === current ? "scene on" : "scene");
  return (
    <div className="story">
      <div className="stage" aria-hidden="true">
        <div className={on(0)}>
          <Picture
            image="kelvin"
            alt="Kelvin, the example company's founder, at his desk"
            sizes="76px"
            className="portrait"
          />
          <span className="sl">NOV 1 · TREASURY</span>
          <div className="sbig">
            <span>{funded}</span> <small>USDC</small>
          </div>
          <span className="scene-sub">Northwind Studio&apos;s treasury on NEAR Intents</span>
          <div className="flowline">
            <span className="chipd">USDC on NEAR</span>
            <span className="track">
              <i />
            </span>
            <span className="chipd">Treasury</span>
          </div>
        </div>
        <div className={on(1)}>
          <Picture
            image="ada"
            alt="Ada, an example contractor, working on a sofa"
            sizes="76px"
            className="portrait"
          />
          <span className="sl">NOV 4 · NEW CONTRACTOR</span>
          <div className="seq">
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
          </div>
          <span className="stamp-success motion-final">✓ SIGNED BY TREASURY</span>
        </div>
        <div className={on(2)}>
          <Picture
            image="kelvin"
            alt="Kelvin, the example company's founder, at his desk"
            sizes="76px"
            className="portrait"
          />
          <span className="sl">NOV 26 · PAYDAY</span>
          <div className="scene-title">5 payouts · 16,500.00 USDC</div>
          <div className="seq">
            {[
              "Quote signed by NEAR Intents",
              "Payee on the signed list",
              "Account key matches",
              "Amount matches exactly",
            ].map((c) => (
              <div key={c} className="chk2">
                <span>{c}</span>
                <span className="pass">PASS</span>
              </div>
            ))}
          </div>
          <span className="signbtn">Approve payouts in wallet · no gas</span>
        </div>
        <div className={on(3)}>
          <span className="sl">NOV 26 · SETTLED</span>
          <div className="scene-title">What the public ledger shows</div>
          <div className="lanes">
            <div className="veilbar" />
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
        </div>
      </div>
      <div className="chapters">
        {CHAPTERS.map((c, i) => (
          <div
            key={c.dt}
            ref={(el) => {
              chaps.current[i] = el;
            }}
            className={i === current ? "chap on" : "chap"}
          >
            <span className="dt">{c.dt}</span>
            <h3>{c.h}</h3>
            <p>{c.p}</p>
          </div>
        ))}
        <div className="dots" aria-hidden="true">
          {CHAPTERS.map((c, i) => (
            <i key={c.dt} className={i === current ? "on" : undefined} />
          ))}
        </div>
      </div>
    </div>
  );
}
