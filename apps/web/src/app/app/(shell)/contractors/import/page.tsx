import type { Metadata } from "next";
import { ImportScreen } from "../../../../../screens/import";

export const metadata: Metadata = { title: "Import contractors · Veylo" };

export default function Page() {
  return <ImportScreen />;
}
