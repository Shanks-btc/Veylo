import "../../../styles/app.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../../../app-ui/shell";

export const metadata: Metadata = { title: "Veylo", robots: { index: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
