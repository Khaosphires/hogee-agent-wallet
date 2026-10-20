"use client";

import { useState } from "react";
import { BadgeCheck, CirclePause, Hourglass, Landmark, Megaphone, Package, Store, Truck, UserPlus, type LucideIcon } from "lucide-react";
import { errorCopy, type Exception, type ExceptionKind } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { clockText, spokenDuration } from "@/components/ui/countdown-format";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import type { Tone } from "@/components/ui/tones";
import { TxHash } from "@/components/ledger/hash";
import { Money } from "@/components/ledger/money";
import { useApiMutation } from "@/lib/api/hooks";
import { REQUESTER_LABEL, STATUS_GROUP } from "@/lib/exception-copy";
import { useNow } from "@/lib/use-now";
import { ExceptionDetail } from "./exception-detail";
import { ReasonDialog } from "./reason-dialog";
import { STATUS_WORD, requestTitle } from "./officer-model";

const KIND_ICON: Record<ExceptionKind, LucideIcon> = {
  RAISE_CAP: Megaphone,
  ADD_PAYEE: UserPlus,
  EXTEND_EXPIRY: Hourglass,
  MOVE_POCKETS: Package,
  UNPAUSE: CirclePause,
  WITHDRAW_RESERVE: Landmark,
  RELEASE_ESCROW_BALANCE: Truck,
  RELEASE_STAGE: BadgeCheck,
  REPLAN: Store,
  POLICY_ESCALATION: Landmark,
};

/**
 * "Can happen in 1:42" until the wait is over (clockText folds minutes into hours and days, so a long wait never reads
 * "1565:38"); screen readers hear the words (spokenDuration). The demo's whole wait is said once, quietly.
 */
function Countdown({ queuedAt, executableAt, over }: { queuedAt: string; executableAt: string; over: boolean }) {
  const now = useNow();
  // The server's status wins: once it says the wait is over, no clock still counts down beside it.
  const left = over ? 0 : Math.max(0, Math.ceil(Number(executableAt) - now / 1000));
  const total = Math.max(0, Number(executableAt) - Number(queuedAt));
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-footnote text-ink-2" data-testid="timelock-countdown" aria-live="off">
      <Hourglass aria-hidden className="size-3.5 text-ink-3" />
      {left > 0 ? (
        <>
          Can happen in{" "}
          <span className="font-mono text-[0.78125rem] text-ink tabular-nums" aria-hidden>
            {clockText(left)}
          </span>
          <span className="sr-only">{spokenDuration(left)}</span>
        </>
      ) : (
        "Wait over"
      )}
      <span className="text-ink-3">· a {spokenDuration(total)} wait</span>
    </span>
  );
}

const needs = (e: Exception): string =>
  [e.requires.founder ? "the founder" : null, e.requires.lender ? "you" : null].filter(Boolean).join(" and ") || "nobody";

const TILE_TONE: Record<ReturnType<typeof groupOf>, Tone> = { "needs-decision": "waiting", timelock: "grey", closed: "grey" };
const groupOf = (e: Exception) => STATUS_GROUP[e.status];

/**
 * One request as a grouped-list row: its template title (never the server's or the seed's), its status in words, who
 * asked and what is at most at risk, what it changes (ExceptionDetail: the target, the new value, the payee, the
 * amount, from the typed payload), then the officer's actions: approve, turn down, or cancel during the wait.
 */
export function ExceptionRow({ exception: e, currency, primary = false }: { exception: Exception; currency?: string; primary?: boolean }) {
  const approve = useApiMutation("approveException");
  const deny = useApiMutation("denyException");
  const veto = useApiMutation("vetoException");
  const [ask, setAsk] = useState<"deny" | "veto">();
  const [confirmOverride, setConfirmOverride] = useState(false);
  const group = groupOf(e);
  const failure = approve.error ?? deny.error ?? veto.error;
  const approveNow = () => approve.mutate({ params: { id: e.exceptionId }, body: {} }, { onSettled: () => setConfirmOverride(false) });
  const canApprove = group === "needs-decision" && e.status !== "APPROVED";

  return (
    <ListRow
      data-testid={`exception-${e.exceptionId}`}
      data-status={e.status}
      leading={<IconTile icon={KIND_ICON[e.kind]} tone={TILE_TONE[group]} variant={group === "needs-decision" ? "solid" : "tinted"} />}
      title={requestTitle(e)}
      value={group === "closed" ? undefined : <Money minor={e.blastRadiusMinor} />}
      subtitle={
        <span className="grid gap-2">
          <span>
            <span data-testid="exception-status">{STATUS_WORD[e.status]}</span> · asked by <span data-testid="exception-requester">{REQUESTER_LABEL[e.requestedBy]}</span>
            {group === "needs-decision" ? ` · needs ${needs(e)}` : null}
            {group !== "closed" ? " · most at risk" : null}
          </span>
          <ExceptionDetail e={e} currency={currency} />
          {e.timelock && group === "timelock" ? <Countdown queuedAt={e.timelock.queuedAt} executableAt={e.timelock.executableAt} over={e.status === "EXECUTABLE"} /> : null}
          {group === "closed" && (e.txs.queue || e.txs.execute) ? (
            <span className="flex flex-wrap gap-x-4 gap-y-1">
              {e.txs.queue ? <span>Started: <TxHash hash={e.txs.queue} /></span> : null}
              {e.txs.execute ? <span>Done: <TxHash hash={e.txs.execute} /></span> : null}
            </span>
          ) : null}
          {failure ? (
            <span className="text-blocked" role="alert">
              {errorCopy(failure.code).title}: {failure.message}
            </span>
          ) : null}
          {group !== "closed" ? (
            <span className="flex flex-wrap gap-2 pt-0.5">
              {canApprove ? (
                <Button size="sm" variant={primary ? "default" : "tinted"} disabled={approve.isPending} onClick={() => (e.kind === "POLICY_ESCALATION" ? setConfirmOverride(true) : approveNow())}>
                  Approve
                </Button>
              ) : null}
              {group === "needs-decision" ? (
                <Button size="sm" variant="secondary" onClick={() => setAsk("deny")}>
                  Deny
                </Button>
              ) : null}
              {group === "timelock" ? (
                <Button size="sm" variant="secondary" onClick={() => setAsk("veto")}>
                  Veto
                </Button>
              ) : null}
            </span>
          ) : null}
          <ReasonDialog
            open={ask !== undefined}
            onOpenChange={(open) => !open && setAsk(undefined)}
            title={ask === "veto" ? "Cancel during the wait" : "Deny this request"}
            description={ask === "veto" ? "The change is cancelled before it happens. No money moves." : "The request is closed. The founder can ask again."}
            confirm={ask === "veto" ? "Veto" : "Deny"}
            pending={deny.isPending || veto.isPending}
            onSubmit={(reason) => {
              const req = { params: { id: e.exceptionId }, body: { reason } };
              const done = { onSuccess: () => setAsk(undefined) };
              if (ask === "veto") veto.mutate(req, done);
              else deny.mutate(req, done);
            }}
          />
          {e.kind === "POLICY_ESCALATION" ? (
            <Dialog open={confirmOverride} onOpenChange={setConfirmOverride}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Approve this payment yourself?</DialogTitle>
                  <DialogDescription>
                    Hogee&apos;s rules stopped this payment and passed it to you. If you approve, it&apos;s sent now. First, Hogee checks again that this
                    person may be paid from this pocket, and that it&apos;s within the limits. If not, nothing is sent.
                  </DialogDescription>
                </DialogHeader>
                <ExceptionDetail e={e} currency={currency} />
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setConfirmOverride(false)}>
                    Cancel
                  </Button>
                  <Button disabled={approve.isPending} onClick={approveNow} data-testid="confirm-override">
                    Approve and pay
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null}
        </span>
      }
    />
  );
}
