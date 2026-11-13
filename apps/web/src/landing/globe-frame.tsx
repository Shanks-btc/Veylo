// The globe's static frame: shown first, under reduced motion, and whenever WebGL is unavailable.
// Computed at build (server component), so it costs no script.
const R = 160;
const C = 200;

function dots(): { x: number; y: number; k: string }[] {
  const out: { x: number; y: number; k: string }[] = [];
  const n = 420;
  const tilt = 0.35;
  for (let i = 0; i < n; i += 1) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = i * 2.39996;
    const x = Math.cos(th) * r;
    const z = Math.sin(th) * r;
    // Tilt towards the viewer, then keep the front half.
    const y2 = y * Math.cos(tilt) - z * Math.sin(tilt);
    const z2 = y * Math.sin(tilt) + z * Math.cos(tilt);
    if (z2 < 0.05) continue;
    out.push({ x: C + x * R, y: C - y2 * R, k: `${i}` });
  }
  return out;
}

const POINTS = dots();
const fix = (v: number) => Math.round(v * 10) / 10;

export function GlobeFrame({ hidden }: { hidden: boolean }) {
  return (
    <div className={`hero-frame${hidden ? " is-hidden" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 400 400" focusable="false">
        <ellipse className="frame-veil" cx={C} cy={C} rx={204} ry={46} strokeWidth="1.2" />
        {POINTS.map((p) => (
          <circle key={p.k} className="frame-dot" cx={fix(p.x)} cy={fix(p.y)} r="1.7" />
        ))}
        <path className="frame-arc-private" d="M150 170 Q 210 60 290 130" strokeWidth="1.4" />
        <path className="frame-arc-direct" d="M150 170 Q 120 90 80 160" strokeWidth="1.4" />
        <path className="frame-arc-private" d="M150 170 Q 230 170 300 240" strokeWidth="1.4" />
        <path className="frame-arc-direct" d="M150 170 Q 170 260 120 290" strokeWidth="1.4" />
      </svg>
    </div>
  );
}
