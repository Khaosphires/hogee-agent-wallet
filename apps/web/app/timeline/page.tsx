import type { Metadata } from "next";
import { PageHead } from "@/components/ui/page-section";
import { ProofTabs } from "@/components/shell/proof-tabs";
import { TimelineView } from "@/components/timeline/timeline-view";

export const metadata: Metadata = { title: "Activity record" };

export default function TimelinePage() {
  return (
    <>
      <PageHead title="Proof" line="Everything the AI and people did, step by step, from the plan to each payment." />
      <ProofTabs />
      <TimelineView />
    </>
  );
}
