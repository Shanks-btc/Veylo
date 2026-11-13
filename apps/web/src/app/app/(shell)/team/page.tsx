import type { Metadata } from "next";
import { TeamScreen } from "../../../../screens/team";

export const metadata: Metadata = { title: "Team and roles · Veylo" };

export default function Page() {
  return <TeamScreen />;
}
