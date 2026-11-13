import type { Metadata } from "next";
import { SetupScreen } from "../../../../screens/setup";

export const metadata: Metadata = { title: "Organisations · Veylo" };

export default function Page() {
  return <SetupScreen />;
}
