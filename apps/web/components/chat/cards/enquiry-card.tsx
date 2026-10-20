"use client";

import { Info, Mail } from "lucide-react";
import type { DataEnquiry } from "@hogee/core";
import { CopyButton } from "@/components/ui/copy-button";
import { UnverifiedPill } from "@/components/ui/pill";
import { useSupplierSearch } from "@/lib/api/queries";
import { enquiryClipboardText } from "@/lib/journey-client";
import { useJourneyThread, type JourneyThread } from "../journey-context";
import { ListingHost } from "./candidates-card";
import { CardShell } from "./card-shell";
import { ENQUIRY_TEXT, enquiryTip } from "./enquiry-copy";
import { enquiryRecipients } from "./search-view";
import type { CardProps } from "./types";

/** The thread's latest web search (ux-chat's JourneyThread field; optional until it lands there). */
type ThreadWithSearch = JourneyThread & { readonly latestSearchId?: string | null };

/**
 * The templated message (built from enums and the quantity only: no names, budget or founder details). Above it, who
 * it is for: each picked supplier's name, place on the list and web page, rendered here from the search's structured
 * data (never from a text part, G3). The founder copies it and sends it on their own; Hogee never sends a message for them.
 */
export function EnquiryCard({ data }: CardProps<DataEnquiry>) {
  const thread = useJourneyThread() as ThreadWithSearch;
  const search = useSupplierSearch(thread.latestSearchId ?? undefined);
  const recipients = enquiryRecipients(data.supplierIds, search.data);
  const n = data.supplierIds.length;
  return (
    <CardShell
      testId="card-enquiry"
      icon={Mail}
      tone="slot-1"
      data-supplier-count={String(n)}
      title={ENQUIRY_TEXT.title}
      subtitle={n === 1 ? ENQUIRY_TEXT.subtitleOne : ENQUIRY_TEXT.subtitleMany(n)}
      badge={<CopyButton text={enquiryClipboardText(data)} label="Copy" copiedLabel="Copied" className="h-10" data-testid="copy-enquiry" />}
    >
      {recipients.length > 0 ? (
        <ul className="grid gap-2" aria-label={ENQUIRY_TEXT.recipients} data-testid="enquiry-recipients">
          {recipients.map((r) => (
            <li key={r.supplierId} data-supplier-id={r.supplierId} className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-ui">
              <span className="font-mono text-[0.8125rem] text-ink-3 tabular-nums">#{r.rank ?? "–"}</span>
              <span className="min-w-0 font-medium text-pretty">{r.name}</span>
              {r.unverified ? <UnverifiedPill /> : null}
              <ListingHost c={{ listingUrl: r.href, listingHost: r.host }} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid gap-3 rounded-lg bg-canvas p-4 text-ui shadow-[inset_0_0_0_1px_var(--line)]">
        <p className="grid gap-0.5">
          <span className="text-meta text-ink-3">Subject</span>
          <span className="font-medium text-pretty" data-testid="enquiry-subject">
            {data.subject}
          </span>
        </p>
        <p className="leading-relaxed whitespace-pre-wrap text-pretty" data-testid="enquiry-body">
          {data.body}
        </p>
      </div>
      <p className="flex items-start gap-2 text-[0.8125rem] text-ink-2" data-testid="enquiry-note">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <span>
          <span className="font-medium text-ink">{ENQUIRY_TEXT.never}</span> {ENQUIRY_TEXT.paste} {enquiryTip(recipients.map((r) => r.rank))}
        </span>
      </p>
    </CardShell>
  );
}
