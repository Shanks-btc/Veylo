import type { Metadata } from "next";
import { AddAddressScreen } from "../../../../../screens/add-address";

export const metadata: Metadata = { title: "Add payout address · Veylo" };

export default function Page() {
  return <AddAddressScreen />;
}
