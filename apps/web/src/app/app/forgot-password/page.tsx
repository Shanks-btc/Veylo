import "../../../styles/app.css";
import type { Metadata } from "next";
import { ForgotPasswordScreen } from "../../../screens/auth-screens";

export const metadata: Metadata = { title: "Reset password · Veylo", robots: { index: false } };

export default function Page() {
  return <ForgotPasswordScreen />;
}
