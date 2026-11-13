import type { Metadata } from "next";
import { AuditScreen } from "../../../../screens/audit";

export const metadata: Metadata = { title: "Audit log · Veylo" };

export default function Page() {
  return <AuditScreen />;
}
