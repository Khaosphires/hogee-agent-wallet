import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { KitchenSink } from "./kitchen-sink";

export const metadata: Metadata = { title: "Design system", robots: { index: false } };
// Dev only, like /dev/passkey: read DEMO_MODE per request, so a normal build never serves this page.
export const dynamic = "force-dynamic";

export default function DevUiPage() {
  if (process.env.DEMO_MODE !== "1") notFound();
  return <KitchenSink />;
}
