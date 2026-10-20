"use client";

import { useQuery } from "@tanstack/react-query";
import { demoDataKey } from "@/components/settings/demo-data-toggle";
import { Tag } from "@/components/ui/pill";
import { useSession } from "@/lib/api/use-session";
import { cn } from "@/lib/utils";

/** The mock-only Sample business switch (GET /api/demo/sample-business); only `on` is read here. */
async function readOn(signal?: AbortSignal): Promise<boolean> {
  const res = await fetch("/api/demo/sample-business", { credentials: "same-origin", cache: "no-store", signal });
  if (!res.ok) return false;
  const body: unknown = await res.json().catch(() => null);
  return typeof body === "object" && body !== null && (body as { on?: unknown }).on === true;
}

/**
 * True while the Sample business (made-up data, mock mode only) is on. Never true in live or replay mode, and false
 * while unknown, so a real signature is never tagged. The key sits under the switch's own key, so flipping the switch
 * refreshes it too.
 */
export function useSampleBusiness(): boolean {
  const mock = useSession().data?.mode === "mock";
  const on = useQuery({ queryKey: [...demoDataKey, "chat-on"], queryFn: ({ signal }) => readOn(signal), enabled: mock, staleTime: 60_000, retry: false });
  return mock && on.data === true;
}

/**
 * The quiet "Sample" beside a seal the sample business made (UX round 3): the seal still means "signed with a passkey";
 * the tag says this signature belongs to the made-up data, not to anything signed in this browser.
 */
export function SampleSealTag({ className }: { className?: string }) {
  return (
    <Tag data-testid="seal-sample" className={cn("align-middle", className)}>
      Sample
    </Tag>
  );
}
