import "../../styles/app.css";
import type { Metadata } from "next";
import { VerifyScreen } from "../../screens/verify";

export const metadata: Metadata = { title: "Verify a payout · Veylo", robots: { index: false } };

export default function Page() {
  return <VerifyScreen />;
}
