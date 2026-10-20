import { FileWarning } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * A compile the API refused because the country pack lacks facts the plan needs (409 COMPILE_FAILED,
 * PACK_FACT_MISSING). Nothing was compiled and nothing was assumed, so there is no plan to show.
 */
export function PackIncomplete({ facts, country }: { facts: readonly string[]; country?: string }) {
  return (
    <Alert data-testid="pack-incomplete">
      <FileWarning />
      <AlertTitle>{country ? `${country}'s` : "This country's"} rules are incomplete</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          Our list of {country ?? "this country's"} rules is missing facts this plan needs. So Hogee built nothing and guessed
          nothing. Your plan shows here once the list is complete.
        </p>
        {facts.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5" aria-label="Missing facts">
            {facts.map((fact) => (
              <li key={fact} className="font-mono text-[0.78125rem] text-ink">
                {fact}
              </li>
            ))}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
