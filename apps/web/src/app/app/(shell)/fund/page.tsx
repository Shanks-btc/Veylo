import type { Metadata } from "next";
import { FundScreen } from "../../../../screens/fund";

export const metadata: Metadata = { title: "Fund treasury · Veylo" };

export default function Page() {
  return <FundScreen />;
}
