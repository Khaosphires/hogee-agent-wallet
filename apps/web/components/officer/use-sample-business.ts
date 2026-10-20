"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useSession } from "@/lib/api/use-session";

/** The fields of the mock-only GET /api/demo/sample-business (components/settings/demo-data-toggle.tsx) read here. */
const SampleState = z.object({ on: z.boolean(), scenario: z.enum(["default", "fresh", "lived"]).nullable() });

/**
 * True while the mock serves the Sample business (scenario "lived"); false outside mock mode; undefined until known.
 * Its own query key, so the switch's cache (demoDataKey) keeps its own shape. Any failure reads as not known (the
 * checklist then shows the plain steps: fail closed, never "done").
 */
export function useSampleBusiness(): boolean | undefined {
  const mode = useSession().data?.mode;
  const state = useQuery({
    queryKey: ["officerSampleBusiness"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/demo/sample-business", { credentials: "same-origin", cache: "no-store", signal });
      if (!res.ok) throw new Error(`The sample business state is not available (${res.status})`);
      const s = SampleState.parse(await res.json());
      return s.on && s.scenario === "lived";
    },
    enabled: mode === "mock",
    retry: false,
    staleTime: 30_000,
  });
  if (mode === undefined) return undefined;
  // An unreadable answer is "not the Sample business": the checklist then shows the plain steps (never "done").
  return mode === "mock" ? (state.isError ? false : state.data) : false;
}

/**
 * Where the word "Sample" goes, as the Wallet decides it (one page-level label when the page is all sample, per-figure
 * tags only where real and sample figures sit side by side): the Wallet's own rule, shared.
 */
export { useSampleScope, type SampleScope } from "@/components/cfo/cfo-parts";
