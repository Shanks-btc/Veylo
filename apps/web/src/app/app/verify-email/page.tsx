import "../../../styles/app.css";
import type { Metadata } from "next";
import { VerifyEmailScreen } from "../../../screens/auth-screens";

export const metadata: Metadata = { title: "Confirm email · Veylo", robots: { index: false } };

export default function Page() {
  return <VerifyEmailScreen />;
}
