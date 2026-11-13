import "../../styles/app.css";
import type { Metadata } from "next";
import { PortalScreen } from "../../screens/portal";

export const metadata: Metadata = { title: "Your payouts · Veylo", robots: { index: false } };

export default function Page() {
  return <PortalScreen />;
}
