"use client";

/**
 * The founder's side of the exception flow on the Wallet page (§4 step 10), in the ui grouped list (UX round 3, Steve
 * #2): requests waiting for the founder's signature, each titled by its kind's template (never its stored title; waiting-model.ts),
 * one per kind with the rest under "Earlier requests", each opening the sign dialog (the only way anything here
 * happens; one filled button, the others tinted). Then "Need a higher limit?" folded, which opens by itself for a link
 * that asks for it (`#change-requests`, `?raise=…`). Before a plan there are no limits to raise, so the fold waits
 * (`canAsk`).
 */
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { ChevronRight, Gauge, PenLine } from "lucide-react";
import { CAP_KINDS, errorCopy, type CapKind, type Exception, type LineKey, type SignatureRequestResponse } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ledger/money";
import { SignDialog, type SignRequest } from "@/components/sign/sign-dialog";
import { useApiMutation } from "@/lib/api/hooks";
import { useBalances, useExceptions } from "@/lib/api/queries";
import { useSession } from "@/lib/api/use-session";
import { STATUS_LABEL } from "@/lib/exception-copy";
import { lineLabel, parseBuInput } from "@/lib/format";
import { isFounderPersona } from "@/lib/persona";
import { raisePrefill } from "@/lib/raise-prefill";
import { groupWaiting, requestTitle } from "./waiting-model";

/** The ui list row's press states, for the one row here that opens in place (the "Need a higher limit?" fold). */
const SUMMARY =
  "group/row flex w-full min-w-0 cursor-pointer list-none items-stretch gap-3 pl-4 text-left outline-none transition-[background-color] duration-(--dur-state) ease-settle hover:bg-fill active:bg-fill-strong active:duration-0 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset [&::-webkit-details-marker]:hidden";

const CAP_LABEL: Record<CapKind, string> = { perTx: "Most per payment", window: "Most per week" };

/** Which signature the founder gives for an exception (mirrors the server's founder branch). */
function signRequestFor(e: Exception): SignRequest | undefined {
  if (e.kind === "RELEASE_ESCROW_BALANCE") return { kind: "MilestoneRelease", refId: e.payload.orderId };
  if (e.kind === "REPLAN") return { kind: "PlanApproval", refId: e.payload.draftId };
  if (e.kind === "RELEASE_STAGE" || e.kind === "POLICY_ESCALATION") return undefined;
  return { kind: "LoosenRequest", refId: e.exceptionId };
}

function AskForChange() {
  const balances = useBalances();
  const create = useApiMutation("createException");
  // A CFO link (`?raise=<line>&cap=<kind>&to=<minor>`) prefills the request. The card renders on the client only (it
  // waits for the client-side session), so the URL is read once, in the initial state.
  const [prefill] = useState(() => (typeof window === "undefined" ? null : raisePrefill(window.location.search)));
  const [lineKey, setLineKey] = useState<LineKey | "">(prefill?.lineKey ?? "");
  const [cap, setCap] = useState<CapKind>(prefill?.cap ?? "perTx");
  const [amount, setAmount] = useState(prefill?.amountBu ?? "");
  const [reason, setReason] = useState("");
  const newCapMinor = parseBuInput(amount);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!lineKey || !newCapMinor || !reason.trim()) return;
    create.mutate({ body: { kind: "RAISE_CAP", payload: { lineKey, cap, newCapMinor }, reason: reason.trim() } }, { onSuccess: () => setAmount("") });
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Ask for a change">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor="change-line">Pocket</Label>
          <select id="change-line" value={lineKey} onChange={(e) => setLineKey(e.target.value as LineKey)} className="h-10 rounded-lg bg-fill px-2.5 text-subhead text-ink outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <option value="">Choose</option>
            {balances.data?.pockets.map((p) => (
              <option key={p.lineKey} value={p.lineKey}>
                {lineLabel(p.lineKey)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="change-cap">Limit</Label>
          <select id="change-cap" value={cap} onChange={(e) => setCap(e.target.value as CapKind)} className="h-10 rounded-lg bg-fill px-2.5 text-subhead text-ink outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {CAP_KINDS.map((k) => (
              <option key={k} value={k}>
                {CAP_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="change-amount">New limit (BU)</Label>
          <Input id="change-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-28" />
        </div>
        <div className="grid min-w-48 flex-1 gap-1">
          <Label htmlFor="change-reason">Why</Label>
          <Input id="change-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </div>
        <Button type="submit" variant="tinted" disabled={!lineKey || !newCapMinor || !reason.trim() || create.isPending}>
          Ask
        </Button>
      </div>
      {create.error ? <p className="text-footnote text-blocked">{errorCopy(create.error.code).title}: {create.error.message}</p> : null}
      <p className="text-footnote text-pretty text-ink-3">
        A higher limit makes the rules less strict. It needs your signature and your loan officer&apos;s, then a short waiting time. You or your loan officer can
        cancel it during the wait.
      </p>
    </form>
  );
}

/**
 * True when the page was opened to ask for a change: a CFO note's prefilled raise link (`?raise=…`) or the
 * `#change-requests` anchor. Read once, on the client (the card renders after the session loads).
 */
const noSubscribe = () => () => undefined;

function openedToAsk(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hash === "#change-requests" || new URLSearchParams(window.location.search).has("raise");
}

/** The requests waiting for the founder's own signature (open or officer-approved, with a signature they give). */
export function useWaitingForSignature(): readonly Exception[] {
  const session = useSession();
  const exceptions = useExceptions();
  const onClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  if (!onClient || !isFounderPersona(session.data?.persona)) return [];
  return (exceptions.data ?? []).filter((e) => e.requires.founder && (e.status === "OPEN" || e.status === "APPROVED") && signRequestFor(e) !== undefined);
}

/**
 * Founder side of the exception flow (§4 step 10). Requests waiting for the founder's signature show at once; asking for a
 * higher limit is folded under "Need a higher limit?" (UX-PLAN D8), and opens by itself for a link that asks for it.
 */
export function ChangeRequests({ canAsk = true }: { canAsk?: boolean }) {
  const session = useSession();
  const waiting = useWaitingForSignature();
  const approve = useApiMutation("approveException");
  const [signing, setSigning] = useState<{ request: SignRequest; initial: SignatureRequestResponse; key: number }>();
  const [askOpen, setAskOpen] = useState(openedToAsk);
  // A link to #change-requests on this page (a note's "ask" link) opens the fold too.
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash === "#change-requests") setAskOpen(true);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // The persona is known on the client only: render after mount, so the server HTML and hydration match.
  const onClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  if (!onClient || !isFounderPersona(session.data?.persona)) return null;

  function sign(e: Exception) {
    const request = signRequestFor(e);
    if (!request) return;
    approve.mutate(
      { params: { id: e.exceptionId }, body: {} },
      { onSuccess: (res) => res.outcome === "SIGNATURE_REQUIRED" && setSigning({ request, initial: res.signature, key: Date.now() }) },
    );
  }

  const { latest, earlier } = groupWaiting(waiting);
  const row = (e: Exception, primary: boolean) => (
    <ListRow
      key={e.exceptionId}
      data-testid={`founder-${e.exceptionId}`}
      data-status={e.status}
      leading={<IconTile icon={PenLine} tone="waiting" />}
      title={requestTitle(e)}
      subtitle={
        <>
          {STATUS_LABEL[e.status]} · up to <Money minor={e.blastRadiusMinor} /> at risk
        </>
      }
      trailing={
        <Button size="sm" variant={primary ? "default" : "tinted"} className="shrink-0 rounded-full" disabled={approve.isPending} onClick={() => sign(e)}>
          Review and sign
        </Button>
      }
    />
  );

  return (
    <div id="change-requests" data-testid="change-requests" className="grid scroll-mt-20 gap-6">
      {waiting.length > 0 ? (
        <div id="waiting-signature" className="grid scroll-mt-20 gap-2">
          <GroupedList header="Waiting for your signature">{latest.map((e, i) => row(e, i === 0))}</GroupedList>
          {earlier.length > 0 ? (
            <details className="group px-1" data-testid="waiting-earlier">
              <summary className="flex h-10 w-fit cursor-pointer list-none items-center gap-1 rounded-lg px-3 text-footnote font-medium text-ink-2 outline-none hover:bg-fill hover:text-ink active:bg-fill-strong focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden className="size-4 text-ink-3 transition-transform duration-(--dur-state) ease-settle group-open:rotate-90" />
                Earlier requests ({earlier.length})
              </summary>
              <GroupedList aria-label="Earlier requests" className="pt-1">
                {earlier.map((e) => row(e, false))}
              </GroupedList>
            </details>
          ) : null}
          {approve.error ? (
            <p className="px-4 text-footnote text-blocked" role="alert">
              {errorCopy(approve.error.code).title}: {approve.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
      {canAsk ? (
        <GroupedList aria-label="Limits">
          <li data-slot="list-row" className="group/item">
            <details open={askOpen} onToggle={(e) => setAskOpen(e.currentTarget.open)} className="group" data-testid="ask-higher-limit">
              <summary className={SUMMARY}>
                <span className="flex shrink-0 items-center py-2">
                  <IconTile icon={Gauge} tone="ink" />
                </span>
                <span className="flex min-h-11 min-w-0 flex-1 items-center gap-3 py-2.5 pr-4">
                  <span className="flex-1 text-callout text-ink">Need a higher limit?</span>
                  <ChevronRight aria-hidden className="size-4 text-ink-4 transition-transform duration-(--dur-state) ease-settle group-open:rotate-90" />
                </span>
              </summary>
              <div className="grid gap-3 px-4 pt-1 pb-4 sm:pl-[3.625rem]">
                <p className="text-footnote text-pretty text-ink-2">Hogee&apos;s AI can only make rules stricter. Anything that loosens them comes through here.</p>
                <AskForChange />
              </div>
            </details>
          </li>
        </GroupedList>
      ) : null}
      {signing ? (
        <SignDialog key={signing.key} request={signing.request} initial={signing.initial} open onOpenChange={(open) => !open && setSigning(undefined)} />
      ) : null}
    </div>
  );
}
