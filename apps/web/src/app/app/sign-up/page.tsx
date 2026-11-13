import "../../../styles/app.css";
import type { Metadata } from "next";
import { SignUpScreen } from "../../../screens/auth-screens";

export const metadata: Metadata = { title: "Create account · Veylo", robots: { index: false } };

export default function Page() {
  return <SignUpScreen />;
}
