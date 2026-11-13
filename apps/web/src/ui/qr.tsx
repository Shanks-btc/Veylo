// A QR code as one SVG path, drawn by this app (qrcode-generator, MIT, no network): nothing is sent
// anywhere to make it, and no inline style is needed (the CSP is style-src 'self').
import qrcode from "qrcode-generator";

export function QrCode({ value, label }: { value: string; label: string }) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  let d = "";
  for (let r = 0; r < n; r += 1)
    for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const size = n + quiet * 2;
  return (
    <svg
      className="qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} className="qr-bg" />
      <path d={d} className="qr-ink" />
    </svg>
  );
}
