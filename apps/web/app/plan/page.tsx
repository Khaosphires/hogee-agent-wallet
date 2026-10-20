import type { Metadata } from "next";
import { PlanView } from "@/components/plan/plan-view";

export const metadata: Metadata = { title: "Your plan" };

/** "Your plan": the page head (PageHead) and its six sections live in components/plan/plan-view.tsx. */
export default function PlanPage() {
  return <PlanView />;
}
