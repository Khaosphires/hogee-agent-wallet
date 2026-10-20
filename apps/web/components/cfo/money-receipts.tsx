"use client";

/**
 * Receipts (UX-PLAN D8, Steve #22; UX round 3 on the ui grouped list): every payment from Mei's wallet as one row,
 * newest first, the latest three and then "Show all": its pocket's tile, "Deposit (payment 1 of 2) to Jinhua Pellora",
 * how it was paid (cobalt when the wallet paid by itself, the seal when she signed), the time and its public receipt, the
 * amount and its state. A failed bank transfer is a "Needs a look" row in the waiting tone that says where the money is.
 * Money set aside for a later step, and refused attempts, get no row (lib/receipts.ts). The rows come from
 * use-receipts.ts (shared with Activity).
 */
import { useState } from "react";
import { CircleAlert, Clock, Landmark, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { Pill } from "@/components/ui/pill";
import { TxHash } from "@/components/ledger/hash";
import { Money } from "@/components/ledger/money";
import { ErrorBlock, RefreshNote } from "@/components/ledger/query-state";
import { lineLabel, localDateTime } from "@/lib/format";
import { howText, STATE_TEXT, type Receipt } from "@/lib/receipts";
import { cn } from "@/lib/utils";
import { pocketLook } from "./pocket-look";
import { useReceipts } from "./use-receipts";
import { lineKeyOfLabel } from "./wallet-activity-model";

const FIRST_ROWS = 3;

function StatePill({ state }: { state: Receipt["state"] }) {
  if (state === "paid") return <Pill tone="paid">{STATE_TEXT.paid}</Pill>;
  if (state === "failed") return <Pill tone="waiting">Needs a look</Pill>;
  return (
    <Pill tone="neutral" icon={<Clock aria-hidden />}>
      {STATE_TEXT.sending}
    </Pill>
  );
}

function receiptTile(r: Receipt) {
  if (r.state === "failed") return <IconTile icon={CircleAlert} tone="waiting" />;
  if (r.how === "tax") return <IconTile icon={Landmark} tone="ink" />;
  const look = pocketLook(r.supplierId ? "SUPPLIER" : lineKeyOfLabel(r.title));
  return <IconTile icon={look.Icon} tone={look.tone} />;
}

/** A record dated ahead of this browser's clock (a clock out of step) shows no time rather than a future date. */
const ahead = (iso: string): boolean => Date.parse(iso) > Date.now() + 60_000;

/** The second line: who paid (the seal when she signed, cobalt when the wallet did), the time, the public receipt. */
function ReceiptLine({ r, currency }: { r: Receipt; currency: string | undefined }) {
  if (r.state === "failed") {
    const pocket = lineKeyOfLabel(r.title);
    return <span className="text-waiting">The bank transfer failed; the BU went back to {pocket ? `the ${lineLabel(pocket)} pocket` : "your wallet"}.</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className={cn("inline-flex items-center gap-1.5", r.how === "auto" ? "text-agent" : "text-ink-2")}>
        {r.how === "passkey" || r.how === "tax" ? <i aria-hidden className="chop" data-size="14" /> : null}
        {howText(r)}
      </span>
      {r.at && !ahead(r.at) ? <time dateTime={r.at}>{localDateTime(r.at, currency)}</time> : null}
      {r.txHash ? <TxHash hash={r.txHash} /> : <span>Receipt not ready yet</span>}
    </span>
  );
}

function ReceiptRow({ r, name, currency }: { r: Receipt; name: string | undefined; currency: string | undefined }) {
  return (
    <ListRow
      data-testid="receipt-row"
      data-how={r.how}
      data-state={r.state}
      leading={receiptTile(r)}
      title={
        <>
          <span className="font-medium">{r.title}</span>
          {r.count ? <span className="text-ink-3"> ({r.count})</span> : null}
          {name ? (
            <>
              {" "}
              to <span className="font-medium">{name}</span>
            </>
          ) : null}
        </>
      }
      subtitle={<ReceiptLine r={r} currency={currency} />}
      value={<Money minor={r.amountMinor} className={cn("font-semibold", r.state === "failed" ? "text-ink-3" : "text-ink")} />}
      trailing={<StatePill state={r.state} />}
    />
  );
}

/** Receipts on the Wallet page: the latest three, then "Show all". */
export function MoneyReceipts({ currency }: { currency: string | undefined }) {
  const { view, names } = useReceipts();
  const receipts = view.kind === "data" ? view.data : [];
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? receipts : receipts.slice(0, FIRST_ROWS);

  return (
    <div className="grid gap-2" data-testid="money-receipts">
      {view.kind === "error" ? <ErrorBlock error={view.error} what="your receipts (nothing was paid or changed)" /> : null}
      {view.kind === "data" ? <RefreshNote error={view.refreshFailed} what="receipts" /> : null}
      <GroupedList aria-label="Receipts" aria-busy={view.kind === "loading"}>
        {view.kind === "loading" ? (
          <ListRow leading={<IconTile icon={ReceiptText} tone="grey" variant="tinted" />} title={<span className="text-ink-3">Loading your receipts…</span>} />
        ) : receipts.length === 0 && view.kind === "data" ? (
          <ListRow
            data-testid="receipts-empty"
            leading={<IconTile icon={ReceiptText} tone="grey" variant="tinted" />}
            title="No payments yet"
            subtitle="Each payment shows here with its public receipt."
          />
        ) : (
          shown.map((r) => <ReceiptRow key={r.key} r={r} name={r.supplierId ? names.get(r.supplierId) : undefined} currency={currency} />)
        )}
      </GroupedList>
      {receipts.length > FIRST_ROWS ? (
        <Button variant="plain" className="w-fit rounded-full" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)} data-testid="receipts-show-all">
          {showAll ? "Show fewer" : `Show all ${receipts.length}`}
        </Button>
      ) : null}
    </div>
  );
}
