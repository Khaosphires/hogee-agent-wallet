import type { Metadata } from "next";
import { PageHeader } from "@/components/shell/page-header";
import { SuppliersView } from "@/components/suppliers/suppliers-view";

export const metadata: Metadata = { title: "Suppliers" };

export default function SuppliersPage() {
  return (
    <>
      <PageHeader
        title="Suppliers"
        description="Suppliers ranked best first. Each one must pass safety checks. You pick one and sign how it gets paid."
      />
      <SuppliersView />
    </>
  );
}
