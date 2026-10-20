import type { Metadata } from "next";
import { Suspense } from "react";
import { CfoPage } from "@/components/cfo/cfo-page";
import { LoadingBlock } from "@/components/ledger/query-state";

export const metadata: Metadata = { title: "Wallet" };

/** Wallet (UX2): an old ?tab= link lands on its section, read with useSearchParams, so the page sits in a Suspense boundary. */
export default function DashboardPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={6} label="Loading your wallet" />}>
      <CfoPage />
    </Suspense>
  );
}
