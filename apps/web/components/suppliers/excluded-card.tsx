"use client";

import { OctagonAlert } from "lucide-react";
import type { SupplierGate } from "@hogee/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { useApiQuery } from "@/lib/api/hooks";
import { GATE_COPY } from "@/lib/supplier-copy";

/** A supplier a hard gate excluded: shown as blocked, with the reason, and never pickable (§11). */
export function ExcludedCard({ supplierId, gate }: { supplierId: string; gate: SupplierGate }) {
  const supplier = useApiQuery("getSupplier", { params: { id: supplierId } }, { poll: false });
  const s = supplier.data;
  const alsoFails: string[] = [];
  if (s && !s.terms.escrow && gate !== "NO_ESCROW") alsoFails.push(GATE_COPY.NO_ESCROW.fail);
  if (s && s.terms.payeeType === "personal" && gate !== "PERSONAL_PAYEE") alsoFails.push(GATE_COPY.PERSONAL_PAYEE.fail);
  if (s && s.terms.offPlatformDiscount && gate !== "OFF_PLATFORM_DISCOUNT") alsoFails.push(GATE_COPY.OFF_PLATFORM_DISCOUNT.fail);
  return (
    <Card data-testid={`excluded-${supplierId}`} className="min-w-0">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {s?.displayName ?? supplierId}
          <Pill tone="blocked">Blocked</Pill>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <p className="flex gap-2.5 rounded-lg bg-blocked-wash px-3 py-2.5 text-[0.8125rem] text-blocked">
          <OctagonAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold" data-testid="blocked-reason">
              {GATE_COPY[gate].fail}.
            </strong>{" "}
            <span className="text-ink-2">It failed a must-pass check, so it can&apos;t be ranked or paid, whatever its price.</span>
          </span>
        </p>
        {alsoFails.length > 0 ? <p className="text-[0.8125rem] text-ink-2">The page also: {alsoFails.join("; ").toLowerCase()}.</p> : null}
      </CardContent>
    </Card>
  );
}
