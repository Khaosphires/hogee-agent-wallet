"use client";

import { useId } from "react";
import Link from "next/link";
import { ArrowRight, Ear, MessageCircleQuestion, Store, TriangleAlert } from "lucide-react";
import type { ChatAction, DataQuestion, HogeeDataParts } from "@hogee/core";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { heardLine } from "@/lib/journey-client";
import { cn } from "@/lib/utils";
import { IconTile } from "@/components/ui/icon-tile";
import { CandidatesCard } from "./cards/candidates-card";
import { CfoCard } from "./cards/cfo-card";
import { EnquiryCard } from "./cards/enquiry-card";
import { NeedsCard } from "./cards/needs-card";
import { NextCard } from "./cards/next-card";
import { OrderCard } from "./cards/order-card";
import { SearchCard } from "./cards/search-card";
import { SignCard } from "./cards/sign-host";
import { TermsCard } from "./cards/terms-card";

export type HogeeUIMessage = UIMessage<unknown, HogeeDataParts>;
type Part = HogeeUIMessage["parts"][number];

/** An answer chip: a tinted pill that answers on pointer-down (DESIGN.md §11), quiet once the question is answered. */
const CHIP = cn(
  "inline-flex min-h-10 max-w-full items-center rounded-full bg-sunk px-4 py-2 text-left text-ui font-medium whitespace-normal text-ink outline-none",
  "transition-[background-color,scale,opacity] duration-(--dur-state) ease-settle hover:bg-sunk-2 focus-visible:ring-[3px] focus-visible:ring-ring/50",
  "active:scale-(--press) active:duration-(--dur-press) disabled:pointer-events-none disabled:opacity-50",
);

function QuestionChips({ question, answered, onAnswer }: { question: DataQuestion; answered: boolean; onAnswer: (value: string) => void }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="grid gap-3.5 rounded-xl bg-card p-4 shadow-card sm:p-5" data-testid="question" data-slot-name={question.slot}>
      <div className="flex items-start gap-3">
        <IconTile icon={MessageCircleQuestion} tone="ink" />
        <p id={id} className="min-w-0 pt-1 text-chat font-medium text-pretty">
          {question.text}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 sm:pl-[42px]">
        {question.options.map((o) => (
          <button key={o.value} type="button" className={CHIP} disabled={answered} onClick={() => onAnswer(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Where a red flag came from, in words (a raw id like "listing:supplier-c" means nothing to Mei; A1.17). */
const redFlagSource = (source: string): string => (source.startsWith("listing:") ? "from a supplier's web page" : "from Hogee's checks");

/** Outside a ChatThread (no thread to send to), a card's button does nothing. */
const NO_ACTION: (a: ChatAction, label: string) => void = () => undefined;

/**
 * Renders one UI-message part: text, one of the five frozen data parts (§26.6), or a chat-first card
 * (VISION-DECISIONS §4: each card reads live state by the ids in its part). data-action renders nothing.
 */
export function MessagePart({
  part,
  answered,
  onAnswer,
  act = NO_ACTION,
}: {
  part: Part;
  answered: boolean;
  onAnswer: (value: string) => void;
  act?: (a: ChatAction, label: string) => void;
}) {
  const card = { answered, act };
  switch (part.type) {
    case "text":
      return <p className="max-w-[62ch] text-chat whitespace-pre-wrap text-pretty">{part.text}</p>;
    case "data-question":
      return <QuestionChips question={part.data} answered={answered} onAnswer={onAnswer} />;
    case "data-intent":
      // UX-PLAN D7: one plain line, not a table of codes. Still labelled AI-drafted for screen readers (the planner filled
      // it); on screen the header says it once (UX round 3 #14).
      return (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-pretty text-ink-2" data-testid="intent-card">
          <IconTile icon={Ear} tone="grey" size="sm" variant="tinted" />
          <span className="font-medium text-ink">What I heard:</span>
          <span>{heardLine(part.data.intent)}</span>
          <span className="sr-only">(AI-drafted)</span>
        </p>
      );
    case "data-plan-draft":
      // Beside a needs card this part is hidden (chat-thread partViews); elsewhere it is one quiet link.
      return (
        <p data-testid="plan-draft-ready">
          <Link
            href="/plan"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg text-ui font-medium text-ink underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            See every rule <ArrowRight aria-hidden className="size-4" />
          </Link>
        </p>
      );
    case "data-shortlist":
      return (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card p-4 shadow-card sm:p-5" data-testid="shortlist-ready">
          <div className="flex min-w-0 flex-[1_1_16rem] items-start gap-3">
            <IconTile icon={Store} tone="slot-1" />
            <p className="text-ui text-pretty">
              <span className="font-medium">I&apos;m finding suppliers.</span> A separate AI reads each page, and Hogee&apos;s code scores them.
            </p>
          </div>
          <Button asChild variant="outline" className="rounded-full bg-card">
            <Link href="/suppliers">
              See suppliers <ArrowRight />
            </Link>
          </Button>
        </div>
      );
    case "data-redflag":
      return (
        <p className="flex items-start gap-3 rounded-xl bg-blocked-wash p-4 text-ui text-pretty" role="note" data-testid="red-flag">
          <IconTile icon={TriangleAlert} tone="blocked" />
          <span className="pt-1">
            <span className="font-medium text-blocked">Red flag: </span>
            {part.data.text} <span className="text-meta text-ink-3">({redFlagSource(part.data.source)})</span>
          </span>
        </p>
      );
    case "data-needs":
      return <NeedsCard data={part.data} {...card} />;
    case "data-sign":
      return <SignCard data={part.data} {...card} />;
    case "data-next":
      return <NextCard data={part.data} {...card} />;
    case "data-action":
      return null;
    case "data-search":
      return <SearchCard data={part.data} {...card} />;
    case "data-candidates":
      return <CandidatesCard data={part.data} {...card} />;
    case "data-enquiry":
      return <EnquiryCard data={part.data} {...card} />;
    case "data-terms":
      return <TermsCard data={part.data} {...card} />;
    case "data-order":
      return <OrderCard data={part.data} {...card} />;
    case "data-cfo":
      return <CfoCard data={part.data} {...card} />;
    default:
      return null;
  }
}
