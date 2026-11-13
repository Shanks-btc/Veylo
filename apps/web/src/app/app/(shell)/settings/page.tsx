import type { Metadata } from "next";
import { SettingsScreen } from "../../../../screens/settings";

export const metadata: Metadata = { title: "Settings · Veylo" };

export default function Page() {
  return <SettingsScreen />;
}
