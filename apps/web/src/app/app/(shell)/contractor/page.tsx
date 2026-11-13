import type { Metadata } from "next";
import { ContractorScreen } from "../../../../screens/contractor";

export const metadata: Metadata = { title: "Contractor · Veylo" };

export default function Page() {
  return <ContractorScreen />;
}
