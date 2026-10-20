"use client";

import { Check, Minus, X } from "lucide-react";
import type { PlanLine, Pocket } from "@hogee/core";
import { IconTile } from "@/components/ui/icon-tile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { slotTone } from "@/components/ui/tones";
import { LINE_SLOT } from "@/components/ledger/line-slots";
import { Money } from "@/components/ledger/money";
import { POCKET_ICON } from "@/components/ledger/pocket-row";
import { bu, lineLabel, unixDate } from "@/lib/format";
import { pocketLimit, pocketPurpose } from "@/lib/plan-rules";

/** The plan's pocket against what the blockchain enforces for it. */
export function Match({ plan, chain }: { plan: string; chain: string | undefined }) {
  if (chain === undefined) {
    return (
      <span className="inline-flex items-center gap-1.5 text-ink-3">
        <Minus aria-hidden className="size-4" /> Not saved yet
      </span>
    );
  }
  return plan === chain ? (
    <span className="inline-flex items-center gap-1.5 font-medium text-paid">
      <Check aria-hidden className="size-4" /> Matches
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 font-medium text-blocked">
      <X aria-hidden className="size-4" /> Different ({bu(chain)} in the public record)
    </span>
  );
}

/**
 * Every pocket in full, behind "Show details" on the plan page: what it is for, its caps, who it may pay, until when,
 * and whether the blockchain holds the same amount (video 0:30). A pocket's purpose is shown through the plain display
 * map (lib/plan-rules pocketPurpose); the signed text is unchanged.
 */
export function LinesVsPockets({ lines, pockets }: { lines: readonly PlanLine[]; pockets: readonly Pocket[] | undefined }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Pocket</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead className="text-right">Most per payment</TableHead>
          <TableHead className="text-right">Most per week</TableHead>
          <TableHead>Paid to</TableHead>
          <TableHead>Open until</TableHead>
          <TableHead>On the blockchain</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((line) => {
          const pocket = pockets?.find((p) => p.lineKey === line.lineKey);
          return (
            <TableRow key={line.lineKey} data-testid={`plan-line-detail-${line.lineKey}`}>
              <TableCell className="whitespace-normal">
                <span className="flex items-center gap-2.5">
                  <IconTile icon={POCKET_ICON[line.lineKey]} tone={slotTone(LINE_SLOT[line.lineKey])} size="sm" />
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{lineLabel(line.lineKey)}</span>
                    <span className="block max-w-64 text-meta text-ink-3">{pocketPurpose(line)}</span>
                  </span>
                </span>
              </TableCell>
              <TableCell className="text-right">
                <Money minor={line.amountMinor} />
              </TableCell>
              <TableCell className="text-right">
                <Money minor={line.perTxCapMinor} />
              </TableCell>
              <TableCell className="text-right">
                <Money minor={line.windowCapMinor} />
              </TableCell>
              <TableCell className="whitespace-normal text-[0.78125rem]">
                {line.escrowOnly || line.pacing ? <p className="font-medium text-ink">{pocketLimit(line).full}</p> : null}
                {line.payeeIds.length > 0 ? <p className="font-mono text-ink-2">{line.payeeIds.join(", ")}</p> : <p className="text-ink-3">No one to pay yet</p>}
              </TableCell>
              <TableCell>{unixDate(line.validUntil)}</TableCell>
              <TableCell>
                <Match plan={line.amountMinor} chain={pocket?.allocated} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
