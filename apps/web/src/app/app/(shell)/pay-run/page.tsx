import type { Metadata } from "next";
import { PayRunReviewScreen } from "../../../../screens/pay-runs";

export const metadata: Metadata = { title: "Review pay run · Veylo" };

export default function Page() {
  return <PayRunReviewScreen />;
}
