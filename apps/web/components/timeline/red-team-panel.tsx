"use client";

import { useState } from "react";
import { Bot, Landmark, ShieldAlert } from "lucide-react";
import { errorCopy, type EvidenceTaskId } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Stat } from "@/components/ui/stat";
import { TxHash } from "@/components/ledger/hash";
import { refusalsIn } from "@/components/evidence/proof-model";
import { useApiMutation } from "@/lib/api/hooks";
import { useTraces } from "@/lib/api/queries";
import { ATTACK_LABELS } from "@/lib/attack-labels";
import { useRecording } from "@/lib/presentation";
import { plainSummary, reasonCopy } from "@/lib/reason-labels";

/** "Stopped so far" from the activity record once there is a refusal in it; before that, how many attacks there are to try. */
function AttackStat() {
  const stopped = refusalsIn(useTraces("300").data);
  if (stopped === undefined) return null;
  return stopped > 0 ? (
    <Stat label="Stopped so far" value={stopped} unit={stopped === 1 ? "attack" : "attacks"} note="Each one is in the activity record." data-testid="attacks-stopped" />
  ) : (
    <Stat label="Attacks to try" value={ATTACK_LABELS.length} note="None has got through." data-testid="attacks-stopped" />
  );
}

/**
 * Runs a red-team attack (DEMO_MODE=1): two walls of evidence, the AI's refusal and the forced send the blockchain
 * rejects (§13.1). It leads Proof's first page as its hero (friction log #34) and is hidden while recording (UX-PLAN
 * D14). The figure is read from the activity record, never assumed.
 */
export function RedTeamPanel() {
  const recording = useRecording();
  const attack = useApiMutation("demoAttack");
  const [attackId, setAttackId] = useState<EvidenceTaskId>("T1");
  if (recording) return null;
  const result = attack.data;
  const forced = result?.forced ? reasonCopy(result.forced.revertReason) : undefined;
  return (
    <section data-testid="red-team" aria-labelledby="red-team-title" className="grid gap-5 rounded-card bg-raised p-5 shadow-lg sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="flex max-w-[46ch] min-w-0 items-start gap-3.5">
          <IconTile icon={ShieldAlert} tone="ink" size="lg" />
          <div className="grid min-w-0 gap-1">
            <h2 id="red-team-title" className="text-title-2 text-ink">
              Try an attack
            </h2>
            <p className="text-subhead text-pretty text-ink-2">Pick a trick a scammer might use. Hogee&apos;s AI says no, then the blockchain refuses it even when forced.</p>
          </div>
        </div>
        <AttackStat />
      </div>
      <div className="flex flex-wrap items-end gap-2.5">
        <div className="grid w-full min-w-0 gap-1.5 sm:w-auto sm:flex-1">
          <Label htmlFor="attack">Attack</Label>
          <Select value={attackId} onValueChange={(v) => setAttackId(v as EvidenceTaskId)}>
            <SelectTrigger id="attack" className="w-full sm:max-w-[26rem]" data-testid="attack-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ATTACK_LABELS.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button disabled={attack.isPending} onClick={() => attack.mutate({ body: { attackId } })}>
          Run attack
        </Button>
      </div>
      {attack.error ? (
        <p className="text-footnote text-blocked" role="alert">
          {attack.error.code === "NOT_FOUND" ? "Demo buttons are off in this version." : `${errorCopy(attack.error.code).title}: ${attack.error.message}`}
        </p>
      ) : null}
      {result ? (
        <div role="status" data-testid="attack-result">
          <GroupedList aria-label="What happened" className="[&>ul]:bg-canvas [&>ul]:shadow-none">
            <ListRow leading={<IconTile icon={Bot} tone="paid" />} title="Wall 1, the AI said no" subtitle={plainSummary(result.refusal.summary)} />
            {result.forced ? (
              <ListRow
                leading={<IconTile icon={Landmark} tone="paid" />}
                title="Wall 2, the blockchain refused it"
                subtitle={
                  <>
                    {forced ? `${forced.title}.${forced.detail ? ` ${forced.detail}` : ""}` : null} <TxHash hash={result.forced.txHash} />
                  </>
                }
              />
            ) : (
              <ListRow leading={<IconTile icon={Landmark} tone="grey" />} title="Never reaches the blockchain" subtitle="Hogee stops this one first." />
            )}
          </GroupedList>
        </div>
      ) : null}
    </section>
  );
}
