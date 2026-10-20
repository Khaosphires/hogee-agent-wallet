"use client";

import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import type { SupplierWithOrder } from "@hogee/api-contract";
import type { RankedSupplier, Shortlist, SupplierWithEvidence } from "@hogee/core";
import { Card, CardContent, CardDescription, CardHeader, CardStub, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/ledger/money";
import { SignAction } from "@/components/sign/sign-action";
import { bpsPct } from "@/lib/format";
import { CRITERION_LABEL, GATE_COPY } from "@/lib/supplier-copy";
import { cn } from "@/lib/utils";

function SourcePill({ supplier }: { supplier?: SupplierWithEvidence }) {
  if (!supplier) return null;
  const live = supplier.listing.sourceType === "live";
  return <Pill tone="outline">{live ? "Live page" : "Sample page"}</Pill>;
}

const SECTION_TITLE = "mb-2 text-meta font-medium text-ink-3";

/**
 * The decision card for one ranked supplier (§11; DESIGN.md §7 candidates). The SupplierApproval signs for the
 * supplier's escrow order when it has one, else for the supplier (the live API then creates the next order;
 * docs/G2-notes-for-P2.md §3), so it waits for the supplier's details. #1 is a money card: it ends in the stub that
 * says what signing allows.
 */
export function SupplierCard({
  candidate,
  shortlist,
  supplier,
}: {
  candidate: RankedSupplier;
  shortlist: Shortlist;
  supplier?: SupplierWithOrder;
}) {
  const lc = candidate.landedCost;
  const top = candidate.rank === 1;
  return (
    <Card data-testid={`supplier-${candidate.supplierId}`} className="min-w-0">
      <CardHeader className="grid-cols-[28px_minmax(0,1fr)] gap-x-3">
        <span aria-hidden className={cn("row-span-2 font-mono text-[1.125rem] leading-[1.25] font-medium tracking-[-0.04em]", top ? "text-ink" : "text-ink-3")}>
          {candidate.rank}
        </span>
        <CardTitle className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="sr-only">Rank {candidate.rank}: </span>
          {candidate.displayName}
          <SourcePill supplier={supplier} />
        </CardTitle>
        <CardDescription>
          Score {candidate.score} out of 100 · <span data-testid="evidence-coverage">{candidate.evidenceCoverageBps > 0 ? `${bpsPct(candidate.evidenceCoverageBps)} of claims proven` : "no claims checked yet"}</span>
          {top && shortlist.rankStabilityPct !== null ? <> · #1 stays on top in {shortlist.rankStabilityPct}% of tests with different weights</> : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
        <div className="grid content-start gap-5">
          <section aria-label="Must-pass checks">
            <p className={SECTION_TITLE}>Must-pass checks</p>
            <ul className="grid gap-1.5 text-[0.84375rem]">
              {candidate.gates.map((g) => (
                <li key={g.gate} className="flex items-start gap-2" data-passed={g.passed}>
                  {g.passed ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-paid" /> : <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-blocked" />}
                  <span className={g.passed ? "text-ink" : "font-medium text-blocked"}>{g.passed ? GATE_COPY[g.gate].pass : GATE_COPY[g.gate].fail}</span>
                </li>
              ))}
            </ul>
          </section>
          {candidate.redFlags.length > 0 ? (
            <section aria-label="Red flags" className="grid gap-1.5">
              <p className={SECTION_TITLE}>Red flags</p>
              {candidate.redFlags.map((f) => (
                <p key={f.text} className="flex gap-2 text-[0.8125rem] text-blocked">
                  <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {f.text} <span className="text-meta text-ink-3">({f.source})</span>
                  </span>
                </p>
              ))}
            </section>
          ) : (
            <p className="flex items-center gap-1.5 text-[0.8125rem] text-ink-3">
              <CircleCheck aria-hidden className="size-3.5" /> No red flags found
            </p>
          )}
          <section className="grid gap-4 text-[0.8125rem] sm:grid-cols-2">
            <div>
              <p className={SECTION_TITLE}>Good</p>
              <ul className="list-disc space-y-1 pl-4 text-ink-2 marker:text-ink-4">{candidate.pros.map((p) => <li key={p.text}>{p.text}</li>)}</ul>
            </div>
            <div>
              <p className={SECTION_TITLE}>Not so good</p>
              <ul className="list-disc space-y-1 pl-4 text-ink-2 marker:text-ink-4">{candidate.cons.map((p) => <li key={p.text}>{p.text}</li>)}</ul>
            </div>
          </section>
          {candidate.whyNotNext ? (
            <p className="text-[0.8125rem]">
              <span className="font-medium text-ink">Why not #{candidate.rank + 1}: </span>
              <span className="text-ink-2" data-testid="why-not-next">{candidate.whyNotNext}</span>
            </p>
          ) : null}
          <p className="text-[0.8125rem]">
            <span className="font-medium text-ink">What would change the ranking: </span>
            <span className="text-ink-2">{candidate.whatWouldChange}</span>
          </p>
        </div>
        <div className="grid content-start gap-5">
          <section aria-label="Delivered cost" className="rounded-lg bg-canvas p-3.5 shadow-[inset_0_0_0_1px_var(--line)]">
            <p className={SECTION_TITLE}>Delivered cost</p>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-[0.84375rem]">
              <dt className="text-ink-2">Goods + shipping</dt>
              <dd className="text-right"><Money minor={lc.cifMinor} /></dd>
              <dt className="text-ink-2">Import tax</dt>
              <dd className="text-right"><Money minor={lc.dutyMinor} /></dd>
              <dt className="text-ink-2">Sales tax on import</dt>
              <dd className="text-right"><Money minor={lc.sstMinor} /></dd>
              <dt className="text-ink-2">Fees</dt>
              <dd className="text-right"><Money minor={lc.feesMinor} /></dd>
              <dt className="border-t border-line pt-2 font-semibold text-ink">Total</dt>
              <dd className="border-t border-line pt-2 text-right font-semibold"><Money minor={lc.totalMinor} /></dd>
            </dl>
            <p className="mt-2 text-meta text-ink-3">
              Exchange rate {lc.fx.value} ({lc.fx.sourceType === "live" ? "live" : "sample"} source)
            </p>
          </section>
          <Table aria-label="Score by criterion">
            <TableHeader>
              <TableRow>
                <TableHead>What we score</TableHead>
                <TableHead className="text-right">How much it counts</TableHead>
                <TableHead className="text-right">Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidate.criteria.map((c) => (
                <TableRow key={c.criterion}>
                  <TableCell>{CRITERION_LABEL[c.criterion]}</TableCell>
                  <TableCell className="text-right">{c.weight}</TableCell>
                  <TableCell className="text-right font-medium">{c.score}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      {top ? (
        <CardStub>
          <p className="min-w-0 flex-[1_1_260px] text-[0.8125rem] text-pretty text-ink-2">
            <strong className="font-medium text-ink">What you&apos;re signing:</strong> how {candidate.displayName} gets paid. Only from your supplier
            pocket, one step at a time. The last payment waits for your delivery check.
          </p>
          <div className="w-full sm:ml-auto sm:w-auto">
            <SignAction request={{ kind: "SupplierApproval", refId: supplier?.orderId ?? candidate.supplierId }} label="Pick and sign the schedule" disabled={!supplier} />
          </div>
        </CardStub>
      ) : null}
    </Card>
  );
}
