import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/shell/page-header";
import { VectorGenerator } from "./vector-generator";

export const metadata: Metadata = { title: "Passkey test vectors", robots: { index: false } };
// Read DEMO_MODE per request, like the API's demo routes, so a normal build never serves this page.
export const dynamic = "force-dynamic";

export default function DevPasskeyPage() {
  if (process.env.DEMO_MODE !== "1") notFound();
  return (
    <>
      <PageHeader
        title="Passkey test vectors"
        description="Developer tool for gate G3: create a passkey on this device, sign random digests, and export each signature encoded for OpenZeppelin WebAuthn.verify."
      />
      <VectorGenerator />
    </>
  );
}
