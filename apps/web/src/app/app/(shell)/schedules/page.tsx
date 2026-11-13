import type { Metadata } from "next";
import { SchedulesScreen } from "../../../../screens/schedules";

export const metadata: Metadata = { title: "Payroll schedules · Veylo" };

export default function Page() {
  return <SchedulesScreen />;
}
