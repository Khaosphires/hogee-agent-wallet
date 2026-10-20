"use client";

import { useEffect, useId, useState, type DragEvent } from "react";
import { Bot, Fingerprint, FileUp, Package, PackageCheck, Upload } from "lucide-react";
import type { DataOrder, EscrowMilestone, OrderTerms } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardStub } from "@/components/ui/card";
import type { Tone } from "@/components/ui/tones";
import { CardHead } from "./card-shell";
import { Countdown } from "@/components/ui/countdown";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pill, UnverifiedPill } from "@/components/ui/pill";
import { Stepper } from "@/components/ui/stepper";
import type { StepperStep } from "@/components/ui/stepper-steps";
import { TxHash } from "@/components/ledger/hash";
import { Money } from "@/components/ledger/money";
import { SealCode } from "@/components/ledger/seal";
import { SealStub, useSealMoment } from "@/components/sign/seal-stub";
import { signerName } from "@/components/sign/seal-time";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { useBalances, useDisplayCurrency, useOrderTerms } from "@/lib/api/queries";
import { stopPaymentsView } from "@/lib/journey-client";
import { useSession } from "@/lib/api/use-session";
import { bu, shortHash } from "@/lib/format";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, uploadErrorText } from "@/lib/live-errors";
import { balanceStepOf, canPayBalance, milestoneName, phaseOf, setGoodsArrived, useGoodsArrived, type BalanceStep, type Phase } from "@/lib/order-phase";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import {
  DROP_HINT,
  DROP_HINT_TOUCH,
  ORDER_TEXT,
  PRACTICE_ACCOUNT,
  PAY_BUTTON,
  PAY_DIALOG_TITLE,
  PAY_SIGNED_TEXT,
  PAY_TEXT,
  PHASE_PILL,
  TRANSIT_PILL,
  TRANSIT_TEXT,
  UPLOAD_BUTTON,
  UPLOAD_TEXT,
  UPLOAD_TEXT_EARLY,
  orderSteps,
  receiptText,
  rowStatusText,
  rowStatusTone,
  rowWaitText,
} from "./order-copy";
import { ScheduleList } from "./schedule-list";
import { ownRecord, signedInThisBrowser, useSignHost } from "./sign-host";
import { SampleSealTag, useSampleBusiness } from "../sample-seal";
import type { CardProps } from "./types";

/** The order's tile: the supplier pocket's colour, cobalt while the wallet pays by itself, green once complete. */
const PHASE_TONE: Record<Phase, Tone> = {
  unsigned: "slot-1",
  binding: "slot-1",
  cooling: "agent",
  paying: "agent",
  waiting: "slot-1",
  done: "paid",
  replaced: "grey",
};

/** Stands in while the terms load, so the card's hooks run in the same order every render. */
const EMPTY_TERMS = { orderId: null, schedule: [] } as unknown as OrderTerms;

/** The file types the API takes for a delivery check report. */
const REPORT_TYPES = "application/pdf,image/jpeg,image/png";

/** The stepper; under 640 px its labels hide (a column is too narrow) and one caption names the current step. */
function OrderSteps({ steps }: { steps: StepperStep[] }) {
  const current = steps.findIndex((st) => st.state === "current");
  return (
    <div className="grid gap-1.5">
      <Stepper steps={steps} aria-label="Order steps" className="max-sm:[&_[data-slot=stepper-step]>span:last-child]:sr-only max-sm:[&_[data-slot=stepper-step]]:pt-6" />
      {current >= 0 ? (
        <p aria-hidden className="text-meta text-ink-2 sm:hidden">
          Step {current + 1} of {steps.length} · {steps[current]?.label}
        </p>
      ) : null}
    </div>
  );
}

function PhasePill({ phase, step }: { phase: Phase; step: BalanceStep | null }) {
  const p = phase === "waiting" && step === "in-transit" ? TRANSIT_PILL : PHASE_PILL[phase];
  return p ? <Pill tone={p.tone}>{p.text}</Pill> : null;
}

interface BalanceState {
  readonly pending: EscrowMilestone;
  readonly step: BalanceStep;
  /** The last payment (the balance), not an earlier one the founder pays. */
  readonly last: boolean;
}

/**
 * The payment waiting on the founder (the first one not released and not automatic) and its step. The Goods arrived
 * gate belongs to the payment after the delivery check; an earlier payment goes straight to its report.
 */
function useBalanceState(terms: OrderTerms, enabled: boolean): BalanceState | null {
  const orderId = terms.orderId ?? "";
  const escrow = useApiQuery("getEscrow", { params: { orderId } }, { enabled: enabled && orderId !== "" });
  const arrived = useGoodsArrived(terms.orderId);
  const pending = enabled ? escrow.data?.find((m) => !m.released && !m.autoRelease) : undefined;
  if (!pending) return null;
  const gated = terms.schedule[pending.idx]?.trigger === "ON_DELIVERY_INSPECTED";
  return { pending, step: balanceStepOf({ evidenceHash: pending.evidenceHash, arrived: arrived || !gated }), last: pending.idx === terms.schedule.length - 1 };
}

/** Shown once the API took the pause request, until the balances say the chain is paused (RCFIX10 A-4). */
const PAUSING_TEXT = "Pausing…";

/**
 * The small stop link and its confirm (the rail's Stop, same mutation), a tighten only. It says paused only when the
 * balances do (as the wallet rail): an accepted request is queued until the chain applies it, so it says "Pausing…" then.
 */
function StopPayments() {
  const [open, setOpen] = useState(false);
  const pause = useApiMutation("pause");
  const paused = useBalances().data?.paused === true;
  const { isSuccess: requested, reset } = pause;
  // Once the chain shows the pause, the request is done: a later resume offers the link again, not "Pausing…".
  useEffect(() => {
    if (paused && requested) reset();
  }, [paused, requested, reset]);
  const view = stopPaymentsView(paused, requested);
  if (view !== "offer") {
    return (
      <span role="status" className="text-meta font-medium text-ink-2" data-testid="order-stop-status" data-state={view}>
        {view === "paused" ? ORDER_TEXT.stopped : PAUSING_TEXT}
      </span>
    );
  }
  return (
    <>
      <Button variant="link" size="sm" className="text-[0.8125rem] text-ink-2" onClick={() => setOpen(true)} data-testid="order-stop">
        {ORDER_TEXT.stopLink}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{ORDER_TEXT.stopTitle}</DialogTitle>
            <DialogDescription>{ORDER_TEXT.stopBody}</DialogDescription>
          </DialogHeader>
          {pause.error ? <p className="text-[0.8125rem] text-blocked">{ORDER_TEXT.stopFailed}</p> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={pause.isPending} onClick={() => pause.mutate(undefined, { onSuccess: () => setOpen(false) })}>
              {ORDER_TEXT.stopConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The safety wait: the server's end time (never a fixed duration), and the small stop link. No other button. */
function CoolingBlock({ terms }: { terms: OrderTerms }) {
  return (
    <div data-testid="cooling-countdown" className="grid gap-2 rounded-lg bg-agent-wash p-3.5 text-[0.8125rem] text-ink-2">
      <span className="inline-flex flex-wrap items-center gap-x-2">
        <span className="font-medium text-agent">{ORDER_TEXT.coolingLead}</span>
        <Countdown to={terms.coolingEndsAt as string} readyText={ORDER_TEXT.coolingOver} className="font-mono text-ink" />
      </span>
      <p className="text-meta text-pretty text-ink-2">{ORDER_TEXT.coolingNote}</p>
      <div>
        <StopPayments />
      </div>
    </div>
  );
}

/** One drop zone for the report: drag a file onto it, or press it to choose one (the input keeps its test label). */
function DropZone({ file, onFile, disabled }: { file: File | undefined; onFile: (f: File | undefined) => void; disabled: boolean }) {
  const id = useId();
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped && REPORT_TYPES.split(",").includes(dropped.type)) onFile(dropped);
  };
  return (
    <label
      htmlFor={id}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        "relative grid min-h-24 cursor-pointer place-items-center gap-1 rounded-lg border border-dashed border-line-2 bg-raised px-4 py-4 text-center outline-none transition-[background-color,border-color,box-shadow] duration-(--dur-state) ease-settle",
        "hover:bg-sunk active:bg-sunk-2 active:duration-(--dur-press) has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50",
        over && "border-ink-3 bg-sunk",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      <FileUp aria-hidden className="size-5 text-ink-3" />
      <span className="text-ui font-medium text-ink">
        {file ? (
          file.name
        ) : (
          <>
            <span className="pointer-coarse:hidden">{DROP_HINT}</span>
            <span className="hidden pointer-coarse:inline">{DROP_HINT_TOUCH}</span>
          </>
        )}
      </span>
      <span className="text-meta text-ink-3">{file ? `${(file.size / 1024).toFixed(0)} KB · press to choose another` : `PDF, JPEG or PNG, up to ${MAX_UPLOAD_LABEL}`}</span>
      <input
        id={id}
        type="file"
        accept={REPORT_TYPES}
        aria-label="Inspection report"
        data-testid="evidence-drop"
        disabled={disabled}
        className="sr-only"
        onChange={(e) => onFile(e.target.files?.[0])}
      />
    </label>
  );
}

/**
 * The payment that waits on the founder (the first one not released and not automatic): Goods arrived (a mark in
 * this browser, UI only) → upload the report (the API stores its check code on the milestone) → Pay the balance (the
 * MilestoneRelease sheet, her passkey). The pay button needs the check code; the Goods arrived mark never opens it.
 */
function BalanceBlock({ orderId, state }: { orderId: string; state: BalanceState }) {
  const upload = useApiMutation("uploadInspection");
  const [file, setFile] = useState<File>();
  const [openedFor, setOpenedFor] = useState<number>();
  const host = useSignHost();
  const { pending, step, last } = state;
  const signed = Boolean(host?.submitted("MilestoneRelease", orderId)) && openedFor === pending.idx;
  const tooBig = file !== undefined && file.size > MAX_UPLOAD_BYTES;
  const amount = bu(pending.amountMinor);

  if (step === "in-transit") {
    return (
      <div data-testid="balance-block" data-step={step} className="grid gap-3 rounded-lg bg-sunk p-3.5 text-[0.8125rem]">
        <p className="text-pretty text-ink-2">{TRANSIT_TEXT}</p>
        <Button className="w-full sm:w-fit" data-testid="goods-arrived" onClick={() => setGoodsArrived(orderId)}>
          <PackageCheck aria-hidden /> Goods arrived
        </Button>
      </div>
    );
  }

  if (step === "upload") {
    return (
      <div data-testid="balance-block" data-step={step} className="grid min-w-0 gap-3 rounded-lg bg-waiting-wash p-3.5 text-[0.8125rem]">
        <p className="text-pretty text-ink-2">
          <strong className="font-medium text-ink">Your turn.</strong> {last ? UPLOAD_TEXT : UPLOAD_TEXT_EARLY}
        </p>
        <DropZone file={file} onFile={setFile} disabled={upload.isPending} />
        {tooBig ? (
          <p className="text-blocked" data-testid="upload-too-big">
            This file is too big (over {MAX_UPLOAD_LABEL}). Please upload a smaller one, like a smaller PDF.
          </p>
        ) : null}
        {upload.error ? (
          <p className="text-blocked" data-testid="upload-error">
            {uploadErrorText(upload.error)}
          </p>
        ) : null}
        {upload.isSuccess ? (
          <p role="status" className="text-ink-2">
            Uploaded. Saving its check code…
          </p>
        ) : (
          <Button className="w-full sm:w-fit" disabled={!file || tooBig || upload.isPending} onClick={() => file && upload.mutate({ params: { orderId }, body: { file } })}>
            <Upload aria-hidden /> {upload.isPending ? "Uploading…" : UPLOAD_BUTTON}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div data-testid="balance-block" data-step={step} className="grid min-w-0 gap-3 rounded-lg bg-waiting-wash p-3.5 text-[0.8125rem]">
      <p className="text-pretty text-ink-2">
        {signed ? (
          PAY_SIGNED_TEXT
        ) : (
          <>
            <strong className="font-medium text-ink">Your turn.</strong> {PAY_TEXT(amount, last)}
          </>
        )}
        {pending.evidenceHash ? (
          <span className="mt-1 block text-meta text-ink-3">
            Check code of the report <span className="font-mono">{shortHash(pending.evidenceHash)}</span>
          </span>
        ) : null}
      </p>
      {signed ? null : (
        <Button
          className="w-full sm:w-fit"
          disabled={!canPayBalance(pending) || !host}
          onClick={() => {
            setOpenedFor(pending.idx);
            host?.open({ kind: "MilestoneRelease", refId: orderId, title: PAY_DIALOG_TITLE(last) });
          }}
        >
          <Fingerprint aria-hidden /> {PAY_BUTTON(last)}
        </Button>
      )}
    </div>
  );
}

/** After the deposit: who paid it and what it could not do (A9.16, A9.17). */
function AgentPaidNote({ bindTxHash }: { bindTxHash: string | null }) {
  return (
    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 rounded-lg bg-agent-wash p-3.5 text-[0.8125rem] text-ink-2">
      <span aria-hidden className="row-span-2 grid size-7 place-items-center rounded-full bg-raised text-agent">
        <Bot className="size-4" />
      </span>
      <p className="flex flex-wrap items-center gap-x-1.5">
        <strong className="font-semibold text-agent">{ORDER_TEXT.agentPaidTitle}</strong>
        {bindTxHash ? (
          <span className="text-ink">
            (<SealCode txHash={bindTxHash} label="stamp" />)
          </span>
        ) : null}
      </p>
      <p className="text-pretty">{ORDER_TEXT.agentPaidBody}</p>
    </div>
  );
}

/** An order and its payments (VISION-DECISIONS §4 data-order): reads getOrderTerms (and getEscrow for the balance). */
export function OrderCard({ data }: CardProps<DataOrder>) {
  const ids = useId();
  const q = useOrderTerms(data.termsId);
  const now = useNow();
  const host = useSignHost();
  const persona = useSession().data?.persona;
  const currency = useDisplayCurrency();
  const paused = useBalances().data?.paused === true;
  const t = q.data;
  // The order's stamp: the bindPayee tx the SupplierApproval sent. It stamps only after a signature from this page that
  // made that tx (the record's tx must be the seal's: a reused termsId in another store build is not this page's).
  const local = ownRecord(host?.submitted("SupplierApproval", data.termsId), t?.bindTxHash);
  const sealing = useSealMoment(Boolean(t?.bindTxHash && local));
  // The order's seal belongs to the sample business when it is on and this browser didn't sign it (a quiet "Sample").
  const sampleSeal = useSampleBusiness() && !local && !signedInThisBrowser("SupplierApproval", data.termsId, t?.bindTxHash);
  const phase = t ? phaseOf(t, now) : null;
  // The balance block opens once nothing automatic is left to pay (or automatic payments are stopped).
  const balanceOpen = phase === "waiting" || (phase === "paying" && paused);
  const balance = useBalanceState(t ?? EMPTY_TERMS, Boolean(t?.orderId) && balanceOpen);
  if (!t || !phase) {
    return (
      <Card role="region" aria-label="Supplier order" aria-busy={!q.error} data-testid="card-order" data-terms-id={data.termsId} className="min-w-0 text-ui">
        <CardHead icon={Package} tone={q.error ? "blocked" : "slot-1"} title={q.error ? "This order couldn't be loaded" : "Loading the order…"} subtitle={q.error ? "Nothing was paid or changed." : undefined} />
      </Card>
    );
  }
  const paidRows = t.schedule.filter((r) => r.released);
  const depositPaid = t.schedule.some((r) => r.autoRelease && r.released);
  return (
    <Card role="region" aria-labelledby={`${ids}-t`} data-testid="card-order" data-terms-id={data.termsId} data-order-id={t.orderId ?? ""} data-phase={phase} className="min-w-0 text-ui">
      <CardHead
        icon={phase === "done" ? PackageCheck : Package}
        tone={PHASE_TONE[phase]}
        titleId={`${ids}-t`}
        title={<>Order with {t.displayName}</>}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 break-words">
            {t.origin === "web" ? <UnverifiedPill /> : null}
            <span>{t.quantity.toLocaleString("en")} units · within the deal you signed</span>
          </span>
        }
        badge={<PhasePill phase={phase} step={balance?.step ?? null} />}
      />

      <CardContent className="grid min-w-0 gap-[18px]">
        <p>
          <Money minor={t.totalMinor} figure="amount" />
        </p>
        {phase === "replaced" ? <p className="text-[0.8125rem] text-ink-2">{ORDER_TEXT.replaced}</p> : null}
        {phase === "unsigned" ? <p className="text-[0.8125rem] text-ink-2">{ORDER_TEXT.unsigned}</p> : null}
        {phase !== "replaced" ? <OrderSteps steps={orderSteps(phase, t.schedule)} /> : null}
        {phase === "binding" ? <p className="text-[0.8125rem] text-ink-2">{ORDER_TEXT.binding}</p> : null}
        {phase === "cooling" ? <CoolingBlock terms={t} /> : null}
        {phase === "done" ? (
          <p role="status" data-testid="order-complete" className="flex items-center gap-2 rounded-lg bg-paid-wash p-3.5 text-[0.8125rem] font-medium text-paid">
            <PackageCheck aria-hidden className="size-4 shrink-0" /> {ORDER_TEXT.done}
          </p>
        ) : null}

        <ScheduleList rows={t.schedule}>
          {(row) => {
            const r = t.schedule[row.idx];
            const state = { autoRelease: row.autoRelease, released: r?.released === true };
            const onTheWay = balance?.step === "in-transit" && balance.pending.idx === row.idx;
            return (
              <>
                <Pill tone={rowStatusTone(state)} icon={state.released ? undefined : null} data-released={String(state.released)}>
                  {rowStatusText(state)}
                </Pill>
                {state.released ? r?.txHash ? <TxHash hash={r.txHash} /> : null : <span>{rowWaitText(row.autoRelease, onTheWay)}</span>}
              </>
            );
          }}
        </ScheduleList>

        {depositPaid ? <AgentPaidNote bindTxHash={t.bindTxHash} /> : null}
        {balance && t.orderId ? <BalanceBlock orderId={t.orderId} state={balance} /> : null}
      </CardContent>

      <CardStub className="mt-1">
        <div className="grid w-full min-w-0 gap-3.5">
          {t.bindTxHash ? (
            <div data-testid="order-seal" className="flex items-start gap-2">
              <SealStub
                className="min-w-0 flex-1"
                txHash={t.bindTxHash}
                signer={signerName(persona)}
                method={local ? local.method : null}
                signedAt={local ? new Date(local.at).toISOString() : undefined}
                currency={currency}
                sealing={sealing}
              />
              {sampleSeal ? <SampleSealTag className="mt-2.5" /> : null}
            </div>
          ) : null}
          <div className="grid gap-1.5 text-[0.8125rem] text-ink-2" data-testid="order-receipts">
            <strong className={paidRows.length > 0 ? "text-ui font-medium text-ink" : "sr-only"}>{ORDER_TEXT.receipt}</strong>
            {paidRows.length > 0 ? (
              paidRows.map((r) => (
                <p key={r.idx} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-[1_1_14rem] text-pretty">{receiptText(t.holderName, milestoneName(r.idx, t.schedule))}</span>
                  {r.txHash ? <TxHash hash={r.txHash} /> : null}
                </p>
              ))
            ) : (
              <p className="text-pretty">{receiptText(t.holderName, null)}</p>
            )}
            <p className="text-meta text-ink-3">
              {paidRows.length > 0 ? `${PRACTICE_ACCOUNT} ` : null}
              {t.orderId ? `Order ${t.orderId}` : null}
            </p>
          </div>
        </div>
      </CardStub>
    </Card>
  );
}
