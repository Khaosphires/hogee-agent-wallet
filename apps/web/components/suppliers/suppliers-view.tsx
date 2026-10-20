"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { RotateCcw, Search, ShieldX } from "lucide-react";
import type { RankedSupplier, Shortlist } from "@hogee/core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorBlock, LoadingBlock } from "@/components/ledger/query-state";
import { POLL_MS, useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { useDisplayCurrency } from "@/lib/api/queries";
import { getChatSessionId } from "@/lib/chat-session";
import { shortHash } from "@/lib/format";
import { missingPackFacts } from "@/lib/live-errors";
import { clearShortlistId, storeShortlistId, storedShortlistId } from "@/lib/supplier-copy";
import { PackIncomplete } from "@/components/plan/pack-incomplete";
import { EscrowCard } from "./escrow-card";
import { ExcludedCard } from "./excluded-card";
import { SupplierCard } from "./supplier-card";

const noop = () => () => {};

/** The supplier the founder picks and signs for (#1: the only one the page offers to sign). */
const chosenOf = (candidates: readonly RankedSupplier[]): RankedSupplier | undefined => candidates.find((c) => c.rank === 1) ?? candidates[0];

function StartShortlist({ onStarted }: { onStarted: (id: string) => void }) {
  const sessionId = useSyncExternalStore(noop, getChatSessionId, () => undefined);
  const draft = useApiQuery("draftPlan", sessionId ? { body: { sessionId } } : undefined, { poll: false, enabled: Boolean(sessionId) });
  const start = useApiMutation("shortlistSuppliers");
  const [quantity, setQuantity] = useState("");
  const intent = draft.data?.intent;
  const supplierLine = draft.data?.manifest.lines.find((l) => l.lineKey === "SUPPLIER");
  const draftGap = missingPackFacts(draft.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!intent || !supplierLine) return;
    start.mutate(
      { body: { spec: { productCategory: intent.productCategory, buyFrom: intent.buyFrom, quantity: Number(quantity), budgetMinor: supplierLine.amountMinor } } },
      { onSuccess: (res) => onStarted(res.requestId) },
    );
  }

  return (
    <Card className="max-w-[720px]">
      <CardContent className="grid gap-5">
        <div className="grid justify-items-start gap-1">
          <span aria-hidden className="mb-2 grid size-9 place-items-center rounded-full bg-sunk text-ink-2">
            <Search className="size-4" />
          </span>
          <h2 className="text-title">Find suppliers</h2>
          <p className="max-w-[60ch] text-[0.8125rem] text-pretty text-ink-2">
            A separate AI reads each supplier page. Then Hogee&apos;s code runs must-pass checks and scores each supplier. Nothing written on a page can change its rank.
          </p>
        </div>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="quantity">Units to order</Label>
            <Input id="quantity" inputMode="numeric" pattern="[1-9][0-9]*" required value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ""))} className="w-36 tabular-nums" />
          </div>
          <Button type="submit" disabled={!intent || !quantity || start.isPending}>
            <Search /> Find suppliers
          </Button>
        </form>
        <div className="grid gap-3 empty:hidden">
          {draftGap ? <PackIncomplete facts={draftGap} /> : <ErrorBlock error={draft.error} what="the plan draft" />}
          <ErrorBlock error={start.error} what="a supplier list" />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A shortlist the server failed closed: nothing was ranked on missing facts. It shows the server's failureReason (G2:
 * a fixed sentence the shortlist code writes, never listing text or an error trace) and any hard gate that already
 * excluded a supplier. A stored result from before G2 has no reason; then it says what can cause one.
 */
function ShortlistFailed({ failureReason, excluded, onRestart }: { failureReason: string | null; excluded: Shortlist["excluded"]; onRestart: () => void }) {
  return (
    <div className="grid gap-5" data-testid="shortlist-failed">
      <Alert variant="destructive">
        <ShieldX />
        <AlertTitle>The supplier search stopped safely: no supplier was ranked</AlertTitle>
        <AlertDescription className="space-y-2">
          <p data-testid="shortlist-failure-reason">
            {failureReason ?? "A listing's text couldn't be read safely, or a supplier check couldn't run."}
          </p>
          <p>Hogee stops rather than rank suppliers on missing facts. No supplier was approved and no money moved.</p>
          <Button variant="secondary" size="sm" className="mt-1" onClick={onRestart}>
            <RotateCcw /> Search again
          </Button>
        </AlertDescription>
      </Alert>
      {excluded.length > 0 ? (
        <section aria-label="Excluded suppliers" className="grid gap-3 lg:grid-cols-2">
          {excluded.map((x) => (
            <ExcludedCard key={x.supplierId} supplierId={x.supplierId} gate={x.gate} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

export function SuppliersView() {
  const stored = useSyncExternalStore(noop, storedShortlistId, () => undefined);
  const [started, setStarted] = useState<string>();
  // After "Search again", the stored id (a failed run) no longer counts.
  const [restarted, setRestarted] = useState(false);
  const requestId = started ?? (restarted ? undefined : stored);
  const currency = useDisplayCurrency();
  const shortlist = useApiQuery("getShortlist", requestId ? { params: { id: requestId } } : undefined, {
    enabled: Boolean(requestId),
    refetchInterval: (q) => (q.state.data?.status === "PENDING" ? 1_500 : false),
  });
  // G2: the chosen supplier's escrow order comes from GET /api/suppliers/:id (null until a SupplierApproval creates
  // one, so it is polled until then). Same query key as its card's, so one request serves both.
  const chosenId = shortlist.data?.status === "READY" ? chosenOf(shortlist.data.candidates)?.supplierId : undefined;
  const chosen = useApiQuery("getSupplier", chosenId ? { params: { id: chosenId } } : undefined, {
    enabled: Boolean(chosenId),
    refetchInterval: (q) => (q.state.data?.orderId === null ? POLL_MS : false),
  });
  const orderId = chosen.data?.orderId ?? null;

  if (!requestId) {
    return (
      <StartShortlist
        onStarted={(id) => {
          storeShortlistId(id);
          setStarted(id);
        }}
      />
    );
  }
  if (shortlist.isPending) return <LoadingBlock rows={5} label="Loading suppliers" />;
  if (shortlist.error) return <ErrorBlock error={shortlist.error} what="the shortlist" />;
  const sl = shortlist.data;
  if (sl.status === "PENDING") return <LoadingBlock rows={5} label="Checking suppliers: must-pass checks first, then the score" />;
  if (sl.status === "FAILED") {
    return (
      <ShortlistFailed
        failureReason={sl.failureReason}
        excluded={sl.excluded}
        onRestart={() => {
          clearShortlistId();
          setStarted(undefined);
          setRestarted(true);
        }}
      />
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-7">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        {sl.candidates.map((c) => (
          <CandidateWithDetail key={c.supplierId} supplierId={c.supplierId}>
            {(supplier) => <SupplierCard candidate={c} shortlist={sl} supplier={supplier} />}
          </CandidateWithDetail>
        ))}
      </div>
      {sl.excluded.length > 0 ? (
        <section aria-label="Excluded suppliers" className="grid gap-3">
          <h2 className="text-title text-ink">Left out: failed a must-pass check</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {sl.excluded.map((x) => (
              <ExcludedCard key={x.supplierId} supplierId={x.supplierId} gate={x.gate} />
            ))}
          </div>
        </section>
      ) : null}
      {orderId ? <EscrowCard orderId={orderId} currency={currency} /> : null}
      <p className="text-meta text-ink-3">
        Scoring version {sl.weightsVersion}
        {sl.shortlistHash ? ` · list check code ${shortHash(sl.shortlistHash)} (part of what you sign)` : ""}
      </p>
    </div>
  );
}

function CandidateWithDetail({ supplierId, children }: { supplierId: string; children: (s: Parameters<typeof SupplierCard>[0]["supplier"]) => React.ReactNode }) {
  const supplier = useApiQuery("getSupplier", { params: { id: supplierId } }, { poll: false });
  return <>{children(supplier.data)}</>;
}
