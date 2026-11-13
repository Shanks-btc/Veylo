import "../../styles/app.css";
import type { Metadata } from "next";
import { DocsPage } from "../../screens/public-docs";

export const metadata: Metadata = {
  title: "Docs · Veylo",
  description:
    "How to run payroll on Veylo, step by step: wallets, funding, contractors, pay runs, currencies and payslips.",
  alternates: { canonical: "/docs" },
};

export default function Page() {
  return <DocsPage />;
}
