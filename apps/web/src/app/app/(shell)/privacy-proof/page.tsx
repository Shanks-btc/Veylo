import type { Metadata } from "next";
import { PageHeader } from "../../../../app-ui/shell";
import { PrivacyProofView } from "../../../../screens/privacy-proof";

export const metadata: Metadata = { title: "Privacy proof · Veylo" };

export default function Page() {
  return (
    <>
      <PageHeader eyebrow="Privacy" title="What the public sees" />
      <PrivacyProofView />
    </>
  );
}
