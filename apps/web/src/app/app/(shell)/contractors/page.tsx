import type { Metadata } from "next";
import { ContractorsScreen } from "../../../../screens/contractors";

export const metadata: Metadata = { title: "Contractors · Veylo" };

export default function Page() {
  return <ContractorsScreen />;
}
