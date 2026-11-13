import "../../../styles/app.css";
import type { Metadata } from "next";
import { PortalBalance } from "../../../screens/portal-balance";

export const metadata: Metadata = {
  title: "Balance and cash out · Veylo",
  robots: { index: false },
};

export default function Page() {
  return <PortalBalance />;
}
