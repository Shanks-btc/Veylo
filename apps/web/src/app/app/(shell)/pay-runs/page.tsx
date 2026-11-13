import type { Metadata } from "next";
import { PayRunsScreen } from "../../../../screens/pay-runs";

export const metadata: Metadata = { title: "Pay runs · Veylo" };

export default function Page() {
  return <PayRunsScreen />;
}
