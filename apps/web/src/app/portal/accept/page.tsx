import "../../../styles/app.css";
import type { Metadata } from "next";
import { PortalAcceptScreen } from "../../../screens/portal";

export const metadata: Metadata = { title: "Join · Veylo", robots: { index: false } };

export default function Page() {
  return <PortalAcceptScreen />;
}
