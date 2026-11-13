import "../../../styles/app.css";
import type { Metadata } from "next";
import { ResetPasswordScreen } from "../../../screens/auth-screens";

export const metadata: Metadata = { title: "New password · Veylo", robots: { index: false } };

export default function Page() {
  return <ResetPasswordScreen />;
}
