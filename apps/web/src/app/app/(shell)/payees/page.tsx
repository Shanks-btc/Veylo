import type { Metadata } from "next";
import { PayeesScreen } from "../../../../screens/payees";

export const metadata: Metadata = { title: "Payee registry · Veylo" };

export default function Page() {
  return <PayeesScreen />;
}
