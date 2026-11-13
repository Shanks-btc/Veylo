import type { Metadata } from "next";
import { PayRunStatusScreen } from "../../../../../screens/pay-runs";

export const metadata: Metadata = { title: "Pay run status · Veylo" };

export default function Page() {
  return <PayRunStatusScreen />;
}
