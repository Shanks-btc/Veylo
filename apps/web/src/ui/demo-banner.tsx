// Shown on every page when the app runs against the demo API (pnpm dev:web). The demo is
// read-only test data; this banner says so on every screen.
export const DEMO = process.env.NEXT_PUBLIC_DEMO === "1";

export function DemoBanner() {
  if (!DEMO) return null;
  return (
    <div className="demo-banner" role="note">
      <strong>Demo data</strong> Made-up people and amounts. Nothing is saved, signed or sent, and
      wallet actions don&apos;t work in the demo.
    </div>
  );
}
