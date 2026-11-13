import "../../../styles/app.css";
import type { Metadata } from "next";
import { PortalAddress } from "../../../screens/portal-address";

export const metadata: Metadata = {
  title: "Your payout address · Veylo",
  robots: { index: false },
};

export default function Page() {
  return <PortalAddress />;
}
