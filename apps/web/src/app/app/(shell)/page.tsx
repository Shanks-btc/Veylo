import type { Metadata } from "next";
import { TreasuryScreen } from "../../../screens/treasury";

export const metadata: Metadata = { title: "Treasury · Veylo" };

export default function Page() {
  return <TreasuryScreen />;
}
