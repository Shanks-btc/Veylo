import "../../styles/app.css";
import type { Metadata } from "next";
import { SecurityPage } from "../../screens/public-legal";

export const metadata: Metadata = {
  title: "Security · Veylo",
  description:
    "What Veylo protects, how it checks every payout in your browser, and how to report a vulnerability.",
  alternates: { canonical: "/security" },
};

export default function Page() {
  return <SecurityPage />;
}
