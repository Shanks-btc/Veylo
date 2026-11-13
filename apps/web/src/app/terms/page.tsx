import "../../styles/app.css";
import type { Metadata } from "next";
import { TermsPage } from "../../screens/public-legal";

export const metadata: Metadata = {
  title: "Terms · Veylo",
  description:
    "Plain-language placeholder terms. Draft, not legal advice; to be reviewed by a lawyer.",
  alternates: { canonical: "/terms" },
};

export default function Page() {
  return <TermsPage />;
}
