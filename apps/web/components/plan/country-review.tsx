"use client";

import type { CountryCode } from "@hogee/core";
import { Pill } from "@/components/ui/pill";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ErrorBlock, LoadingBlock } from "@/components/ledger/query-state";
import type { ApiClientError } from "@/lib/api/client";
import { PackIncomplete } from "./pack-incomplete";
import { ShowDetails } from "./show-details";

export const COUNTRY_LABEL: Record<CountryCode, string> = { SG: "Singapore", MY: "Malaysia", ID: "Indonesia" };
/** The country switch (SG-DECISIONS): Singapore, then Malaysia. Indonesia stays in the code but leaves the UI. */
export const SWITCH_COUNTRIES = ["SG", "MY"] as const satisfies readonly CountryCode[];
type SwitchCountry = (typeof SWITCH_COUNTRIES)[number];
const isSwitchCountry = (v: string): v is SwitchCountry => (SWITCH_COUNTRIES as readonly string[]).includes(v);

/**
 * The reviewers' country preview, folded at the bottom of the plan (UX-PLAN D30): the same plan worked out under
 * another country's rules. Preview only; nothing is signed or changed.
 */
export function CountryReview({
  home,
  target,
  onSwitch,
  previewing,
  switchMs,
  pending,
  error,
  gap,
}: {
  home: CountryCode;
  target: CountryCode | undefined;
  onSwitch: (country: CountryCode) => void;
  previewing: boolean;
  switchMs: number | undefined;
  pending: boolean;
  error: ApiClientError | null;
  gap: readonly string[] | undefined;
}) {
  return (
    <ShowDetails label="For reviewers: preview this plan in another country" testId="country-review" className="rounded-xl bg-card px-4 py-1 shadow-card sm:px-5">
      <div className="flex flex-wrap items-center gap-3 pb-2">
        <span className="text-footnote font-medium text-ink-2">Country rules</span>
        <ToggleGroup
          type="single"
          aria-label="Country"
          value={target ?? ""}
          onValueChange={(v) => {
            // Radix sends "" when the active country is clicked again; keep it.
            if (isSwitchCountry(v)) onSwitch(v);
          }}
        >
          {SWITCH_COUNTRIES.map((cc) => (
            <ToggleGroupItem
              key={cc}
              value={cc}
              title={cc === home ? "The country this plan was made for" : "Preview only; nothing is signed"}
              className="min-w-24 flex-none px-3.5 transition-[color,background-color,box-shadow,scale]"
            >
              {COUNTRY_LABEL[cc]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {previewing ? (
          <Pill tone="outline" data-testid="country-preview">
            Preview only{switchMs !== undefined ? ` · switched in ${(switchMs / 1000).toFixed(1)} s` : ""}
          </Pill>
        ) : null}
      </div>
      <p className="pb-2 text-meta text-ink-3">The page above shows the preview. Nothing is signed or changed.</p>
      {previewing && pending ? <LoadingBlock rows={4} label="Working out the plan for the other country" /> : null}
      {gap && target ? <PackIncomplete facts={gap} country={COUNTRY_LABEL[target]} /> : <ErrorBlock error={error} what="the country preview" />}
    </ShowDetails>
  );
}
