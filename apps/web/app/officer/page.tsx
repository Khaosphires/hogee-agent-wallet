import type { Metadata } from "next";
import { OfficerView } from "@/components/officer/officer-view";

export const metadata: Metadata = { title: "Loan officer" };

/** The loan officer's console: the page head and the console come from OfficerView (it knows the founder's name). */
export default function OfficerPage() {
  return <OfficerView />;
}
