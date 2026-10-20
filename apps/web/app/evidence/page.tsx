import type { Metadata } from "next";
import { PageHead } from "@/components/ui/page-section";
import { WalletDetails } from "@/components/dashboard/wallet-details";
import { EvidenceView } from "@/components/evidence/evidence-view";
import { FiscoSection } from "@/components/evidence/fisco-section";
import { ProofTabs } from "@/components/shell/proof-tabs";
import { RedTeamPanel } from "@/components/timeline/red-team-panel";

export const metadata: Metadata = { title: "Proof" };

/**
 * Proof → Checks: "Try an attack" leads (friction log #34), then the proof pack and its tests, the FISCO BCOS mirror,
 * then the wallet as the chain counts it.
 */
export default function EvidencePage() {
  return (
    <>
      <PageHead title="Proof" line="Hogee's rules, tested: every check and attack with its receipt. Works offline." />
      <ProofTabs />
      {/* Bento (P1: layout A): the attack hero, the checked pack and its tests side by side where they fit; the wallet as
          the chain counts it below. */}
      <div className="bento bento-grid items-start gap-y-6">
        <div className="grid bm-7 bl-7 bx-4">
          <RedTeamPanel />
        </div>
        <EvidenceView />
        {/* REG-BRIEF (fisco-proof): the same run on FISCO BCOS, with the regulator's own stops, checked in the browser. */}
        <FiscoSection />
        <div className="grid bm-12">
          <WalletDetails />
        </div>
      </div>
    </>
  );
}
