import type { Metadata } from "next";
import { LedgerScreen } from "../../../../screens/ledger";

export const metadata: Metadata = { title: "Ledger · Veylo" };

export default function Page() {
  return <LedgerScreen />;
}
