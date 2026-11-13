import "../../styles/app.css";
import type { Metadata } from "next";
import { PrivacyPolicyPage } from "../../screens/public-legal";

export const metadata: Metadata = {
  title: "Privacy policy · Veylo",
  description: "What Veylo keeps, what it never has, and what private means.",
  alternates: { canonical: "/privacy" },
};

export default function Page() {
  return <PrivacyPolicyPage />;
}
