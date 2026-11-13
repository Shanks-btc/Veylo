import "../../../styles/app.css";
import type { Metadata } from "next";
import { SignInScreen } from "../../../screens/auth-screens";

export const metadata: Metadata = { title: "Sign in · Veylo", robots: { index: false } };

export default function Page() {
  return <SignInScreen />;
}
