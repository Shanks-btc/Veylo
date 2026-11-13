import type { Metadata } from "next";
import { StatementsScreen } from "../../../../screens/statements";

export const metadata: Metadata = { title: "Statements · Veylo" };

export default function Page() {
  return <StatementsScreen />;
}
