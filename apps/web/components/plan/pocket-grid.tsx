"use client";

import { CircleCheck, CircleDashed, OctagonAlert } from "lucide-react";
import type { PlanLine, Pocket } from "@hogee/core";
import { IconTile } from "@/components/ui/icon-tile";
import { ProgressRing } from "@/components/ui/progress";
import { Stat } from "@/components/ui/stat";
import { slotTone } from "@/components/ui/tones";
import { LINE_SLOT } from "@/components/ledger/line-slots";
import { Money } from "@/components/ledger/money";
import { POCKET_ICON } from "@/components/ledger/pocket-row";
import { lineLabel, pctOf } from "@/lib/format";
import { pocketFigures, pocketLimit, type PocketFigures } from "@/lib/plan-rules";
import { LinesVsPockets } from "./lines-vs-pockets";
import { ShowDetails } from "./show-details";

/** What escrow holds and has paid the supplier (GET /api/balances escrowMinor; the CFO report's pnl.supplierCostMinor). */
export interface EscrowFigures {
  readonly escrowMinor: string;
  /** null while the CFO report loads: the supplier pocket then says only what is left. */
  readonly supplierPaidMinor: string | null;
}

/** "1,500 BU paid · 700 BU set aside · 2,800 BU left", the parts that are not zero; each part never breaks inside. */
function FiguresLine({ fig }: { fig: PocketFigures }) {
  const paid = fig.paidMinor === null ? null : BigInt(fig.paidMinor);
  const aside = fig.setAsideMinor === null ? null : BigInt(fig.setAsideMinor);
  if (paid === 0n && aside === 0n) return <span data-testid="pocket-figures">Nothing paid yet</span>;
  const parts = [
    ...(paid !== null && paid > 0n ? [{ key: "paid", minor: fig.paidMinor as string, word: "paid" }] : []),
    ...(aside !== null && aside > 0n ? [{ key: "aside", minor: fig.setAsideMinor as string, word: "set aside" }] : []),
    { key: "left", minor: fig.leftMinor, word: "left" },
  ];
  return (
    <span data-testid="pocket-figures">
      {parts.map((part, i) => (
        <span key={part.key}>
          {i > 0 ? " · " : null}
          <span className="whitespace-nowrap" data-part={part.key}>
            <Money minor={part.minor} /> {part.word}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * One pocket as a card (the review keeps the cards): its tile and name, its amount in the plan, and, once it exists on
 * the blockchain, what it has paid, what is set aside for the supplier and what is left, read exactly as the Wallet
 * reads it (lib/plan-rules pocketFigures), with the same ring: it fills as money goes out. Before signing, its share of
 * the budget. Its limit is one chip under it.
 */
function PocketCard({ line, pocket, escrow, totalMinor }: { line: PlanLine; pocket: Pocket | undefined; escrow: EscrowFigures | undefined; totalMinor: string }) {
  const limit = pocketLimit(line);
  const name = lineLabel(line.lineKey);
  const tone = slotTone(LINE_SLOT[line.lineKey]);
  const differs = pocket !== undefined && pocket.allocated !== line.amountMinor;
  const fig = pocket
    ? pocketFigures(pocket, { escrowOnly: line.escrowOnly, escrowMinor: escrow?.escrowMinor ?? "0", supplierPaidMinor: escrow ? escrow.supplierPaidMinor : null })
    : undefined;
  return (
    <li
      data-testid={`plan-line-${line.lineKey}`}
      // A container: in a roomy card the ring sits in the corner beside the name (the label row keeps room for it); in
      // a narrow one (a phone's two columns) it sits at the end of the limit's row, so the name keeps its full width.
      className="@container relative grid min-w-0 content-start gap-3 rounded-xl bg-card p-4 shadow-card sm:p-[18px] [&_[data-slot=stat]>div:first-child>span:last-child]:whitespace-normal @min-[13rem]:[&_[data-slot=stat]>div:first-child]:pr-8"
    >
      <Stat
        label={name}
        leading={<IconTile icon={POCKET_ICON[line.lineKey]} tone={tone} size="sm" />}
        minor={line.amountMinor}
        size="md"
        note={fig ? <FiguresLine fig={fig} /> : `${Math.round(pctOf(line.amountMinor, totalMinor))}% of your budget`}
      />
      {differs ? (
        <p className="inline-flex w-fit items-center gap-1 rounded-full bg-tint-blocked px-2 py-0.5 text-caption font-medium text-blocked">
          <OctagonAlert aria-hidden className="size-3.5" /> Different on the blockchain
        </p>
      ) : null}
      <div className="flex items-end justify-between gap-2">
        <p className="w-fit rounded-sm bg-fill px-2 py-1 text-caption font-medium text-ink-2" title={limit.full} data-testid="pocket-limit">
          <span aria-hidden>
            {limit.parts.map((part, i) => (
              <span key={part}>
                {i > 0 ? " · " : null}
                <span className="whitespace-nowrap">{part}</span>
              </span>
            ))}
          </span>
          <span className="sr-only">{limit.full}</span>
        </p>
        {fig ? (
          <ProgressRing
            value={fig.usedPct}
            tone={tone}
            size={26}
            stroke={3.5}
            label={`${name}: ${Math.round(fig.usedPct)}% paid out`}
            className="@min-[13rem]:absolute @min-[13rem]:top-3 @min-[13rem]:right-3"
          />
        ) : null}
      </div>
    </li>
  );
}

/** One line under the tiles: does the blockchain hold the same pockets? */
function ChainLine({ lines, pockets }: { lines: readonly PlanLine[]; pockets: readonly Pocket[] | undefined }) {
  if (!pockets || pockets.length === 0) {
    return (
      <p className="flex items-center gap-2 text-footnote text-ink-2" data-testid="pockets-chain" data-state="not-saved">
        <CircleDashed aria-hidden className="size-4 text-ink-3" /> Saved to the blockchain when you sign
      </p>
    );
  }
  const differ = lines.filter((l) => pockets.find((p) => p.lineKey === l.lineKey)?.allocated !== l.amountMinor).length;
  return differ === 0 ? (
    <p className="flex items-center gap-2 text-footnote font-medium text-paid" data-testid="pockets-chain" data-state="match">
      <CircleCheck aria-hidden className="size-4" /> All {lines.length} pockets match the blockchain
    </p>
  ) : (
    <p className="flex items-center gap-2 text-footnote font-medium text-blocked" data-testid="pockets-chain" data-state="differ">
      <OctagonAlert aria-hidden className="size-4" /> {differ} of {lines.length} pockets differ from the blockchain
    </p>
  );
}

/**
 * The pockets as cards (iOS Settings style): each one's glyph in its chart colour, name, amount, what it has paid and
 * has left (as the Wallet says it) with its ring, and its limit as one chip. Every cap, payee, end date and the
 * side-by-side with the blockchain is one tap away.
 */
export function PocketGrid({
  lines,
  pockets,
  escrow,
  totalMinor,
}: {
  lines: readonly PlanLine[];
  pockets: readonly Pocket[] | undefined;
  escrow: EscrowFigures | undefined;
  totalMinor: string;
}) {
  return (
    <div className="grid gap-3.5">
      <ul className="bento-six grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 lg:grid-cols-3" aria-label="Pockets">
        {lines.map((line) => (
          <PocketCard key={line.lineKey} line={line} pocket={pockets?.find((p) => p.lineKey === line.lineKey)} escrow={escrow} totalMinor={totalMinor} />
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
        <ChainLine lines={lines} pockets={pockets} />
        <ShowDetails label="Every limit, in full" testId="pockets-details" className="w-full">
          <div className="rounded-group bg-card px-1 py-1 shadow-card sm:px-2">
            <LinesVsPockets lines={lines} pockets={pockets} />
          </div>
        </ShowDetails>
      </div>
    </div>
  );
}
