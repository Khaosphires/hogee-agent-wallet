"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Clock, Fingerprint, LoaderCircle, RotateCcw, ScrollText } from "lucide-react";
import type { ChainAction, DataSign, PlanRecord, SignatureKind } from "@hogee/core";
import { TxHash } from "@/components/ledger/hash";
import { SealStub, useSealMoment } from "@/components/sign/seal-stub";
import { signerName } from "@/components/sign/seal-time";
import { SignButton } from "@/components/sign/sign-button";
import { SignDialog, type SignMethodUsed } from "@/components/sign/sign-dialog";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { POLL_MS, apiKey, useApiQuery } from "@/lib/api/hooks";
import { useDisplayCurrency } from "@/lib/api/queries";
import { useSession } from "@/lib/api/use-session";
import { keptSignature, pageOwnsSeal, signKey, signPollInterval, signProgress, withSignedTx, type SignProgress, type SignState, type SignedLocally } from "@/lib/journey-client";
import { useJourneyThread, useNeedsDraftIdsInMessage } from "../journey-context";
import { SampleSealTag, useSampleBusiness } from "../sample-seal";
import { IconTile } from "@/components/ui/icon-tile";
import type { Tone } from "@/components/ui/tones";
import { CardShell } from "./card-shell";
import type { CardProps } from "./types";

// ---- the host ---------------------------------------------------------------------------------------------------
export interface SignOpenRequest {
  readonly kind: SignatureKind;
  readonly refId: string;
  readonly title: string;
}

export interface Submitted {
  readonly req: SignOpenRequest;
  readonly action: ChainAction;
  /** How the founder signed (a passkey or a wallet), for the signed line. */
  readonly method: SignMethodUsed;
  /** When the founder's signature was accepted (ms), for the signed line. */
  readonly at: number;
  /** The current plan's tx when the dialog opened, so an older committed plan isn't read as this signature. */
  readonly baselineTx: string | null;
  /** The tx the submit answered with (null: a live submit is queued without one). The seal is this page's only with it. */
  readonly txHash: string | null;
}

interface SignHostValue {
  readonly open: (req: SignOpenRequest) => void;
  readonly submitted: (kind: SignatureKind, refId: string) => Submitted | undefined;
  /** Every signature submitted from this page, oldest first (the wallet rail's "Your seals"). */
  readonly all: readonly Submitted[];
}

const SignHostContext = createContext<SignHostValue | null>(null);

/** The thread's signing host, or null outside one (cards then show their sign button disabled). */
export const useSignHost = (): SignHostValue | null => useContext(SignHostContext);

/**
 * After the dialog closes, put focus back where the founder was: Radix returns it to the opener, but the opener may be
 * gone (the card now shows its status instead), so fall back to the card's status, never to the page top.
 */
function refocusAfterClose(opener: HTMLElement | null, key: string) {
  const started = performance.now();
  const tick = () => {
    if (document.querySelector('[data-slot="dialog-content"]') && performance.now() - started < 1_000) {
      requestAnimationFrame(tick);
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    if (opener?.isConnected && !opener.matches(":disabled")) opener.focus();
    else document.querySelector<HTMLElement>(`[data-sign-status-key="${CSS.escape(key)}"]`)?.focus();
  };
  requestAnimationFrame(tick);
}

/**
 * ONE SignDialog for the whole thread (VISION-DECISIONS §4 / v-chat-ui brief): mounted above the messages, so a new
 * reply, a re-render or regenerate() never unmounts it mid-signature. Cards call `useSignHost().open(…)`. The dialog
 * fetches the request first and the founder then clicks Sign: that click is the fresh user gesture Safari needs for
 * WebAuthn. On submit the host remembers the result and calls `onSigned` (the thread sends the `signed` action).
 */
export function SignHost({ children, onSigned }: { readonly children: ReactNode; readonly onSigned?: (req: SignOpenRequest, action: ChainAction) => void }) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState<{ req: SignOpenRequest; session: number; baselineTx: string | null }>();
  const [isOpen, setIsOpen] = useState(false);
  const [records, setRecords] = useState<ReadonlyMap<string, Submitted>>(() => new Map());
  const opener = useRef<HTMLElement | null>(null);
  const onSignedRef = useRef(onSigned);
  useEffect(() => {
    onSignedRef.current = onSigned;
  });

  const open = useCallback(
    (req: SignOpenRequest) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const plan = queryClient.getQueryData<PlanRecord>(apiKey("getCurrentPlan"));
      setCurrent((c) => ({ req, session: (c?.session ?? 0) + 1, baselineTx: plan?.txHash ?? null }));
      setIsOpen(true);
    },
    [queryClient],
  );

  const value = useMemo<SignHostValue>(() => ({ open, submitted: (kind, refId) => records.get(signKey(kind, refId)), all: [...records.values()] }), [open, records]);

  function onOpenChange(next: boolean) {
    setIsOpen(next);
    if (!next && current) refocusAfterClose(opener.current, signKey(current.req.kind, current.req.refId));
  }

  function onDone(action: ChainAction, method: SignMethodUsed) {
    if (!current) return;
    const { req, baselineTx } = current;
    const at = Date.now();
    const txHash = action.txHash ?? null;
    rememberSignedAt(signKey(req.kind, req.refId), { at, method, txHash });
    setRecords((prev) => new Map(prev).set(signKey(req.kind, req.refId), { req, action, method, baselineTx, at, txHash }));
    onSignedRef.current?.(req, action);
  }

  return (
    <SignHostContext.Provider value={value}>
      {children}
      {current ? (
        <SignDialog
          key={current.session}
          request={{ kind: current.req.kind, refId: current.req.refId }}
          title={current.req.title}
          open={isOpen}
          onOpenChange={onOpenChange}
          onDone={onDone}
        />
      ) : null}
    </SignHostContext.Provider>
  );
}

// ---- when it was signed, across a reload ------------------------------------------------------------------------
/**
 * The records carry no signing time or method, so this browser keeps the time it sent each signature (its own clock, as
 * the stamp line always showed) and how it was signed, to keep "Signed by Mei with a passkey · 19 Oct, 13:32 SGT" on
 * the stamp after a reload. Convenience only: storage may be missing, and then the line says less, never something
 * made up. Each entry also keeps the tx the signature made, and a seal is this browser's only when it carries that tx
 * (run-10 v-1: the mock reuses refIds across store builds, e.g. the Sample business's made-up commit of the same draft).
 */
const SIGNED_AT_KEY = "hogee.signedAt";

function readSignedAt(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SIGNED_AT_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rememberSignedAt(key: string, entry: SignedLocally): void {
  try {
    window.localStorage.setItem(SIGNED_AT_KEY, JSON.stringify({ ...readSignedAt(), [key]: entry }));
  } catch {
    // Storage unavailable: the stamp shows its time until the page reloads.
  }
}

/** Fills in the tx of the entry this page wrote at `at`, once its seal confirmed (a live submit had none yet). */
function rememberSignedTx(key: string, at: number, txHash: string): void {
  try {
    const next = withSignedTx(readSignedAt(), key, at, txHash);
    if (next) window.localStorage.setItem(SIGNED_AT_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: after a reload the stamp says less (no method or time), never something made up.
  }
}

/** What this browser kept about the seal `sealTx` for `key`: only when it is this browser's own signature. */
function storedSignature(key: string, sealTx: string | null | undefined): { readonly signedAt: string; readonly method: SignMethodUsed } | undefined {
  if (typeof window === "undefined") return undefined;
  return keptSignature(readSignedAt()[key], sealTx ?? null);
}

/** True when this browser sent the signature for (kind, refId) that made the seal `sealTx`: then it is never the sample business's. */
export const signedInThisBrowser = (kind: SignatureKind, refId: string, sealTx: string | null | undefined): boolean => storedSignature(signKey(kind, refId), sealTx) !== undefined;

/** The record from this page behind the seal `sealTx`, if it made it (journey-client pageOwnsSeal). */
export function ownRecord(local: Submitted | undefined, sealTx: string | null | undefined): Submitted | undefined {
  return local && pageOwnsSeal(local.txHash, sealTx) ? local : undefined;
}

/** Once this page's queued (live) signature confirms, keep its seal's tx so a reload still knows the seal is the founder's. */
function useKeepConfirmedTx(key: string, local: Submitted | undefined, progress: SignProgress): void {
  const tx = progress.state === "confirmed" && local && local.txHash === null ? progress.txHash : null;
  const at = local?.at;
  useEffect(() => {
    if (tx && at !== undefined) rememberSignedTx(key, at, tx);
  }, [key, at, tx]);
}

// ---- progress -----------------------------------------------------------------------------------------------------
const isTermsId = (refId: string): boolean => /^terms-[0-9a-z-]+$/.test(refId);

/**
 * Where a signature stands: from this page's submit, or a `signed` action in the thread, then confirmed by the
 * record it changes (polled every 1.5 s only while waiting). See lib/journey-client signProgress.
 */
export function useSignProgress(kind: SignatureKind, refId: string): SignProgress & { readonly readFailed: boolean } {
  const host = useSignHost();
  const { signedKeys } = useJourneyThread();
  const local = host?.submitted(kind, refId);
  const submitted = Boolean(local) || signedKeys.has(signKey(kind, refId));
  const base = { kind, submitted, submittedTx: local?.txHash ?? null, baselineTx: local?.baselineTx ?? null };
  // Poll every 1.5 s only while the signature is out and the record doesn't show it yet (never once superseded).
  const waiting = (p: SignProgress) => signPollInterval(p, POLL_MS);
  const plan = useApiQuery("getCurrentPlan", undefined, {
    enabled: kind === "PlanApproval",
    refetchInterval: (q) => waiting(signProgress({ ...base, plan: q.state.data ?? null })),
  });
  const terms = useApiQuery("getOrderTerms", { params: { id: refId } }, {
    enabled: kind === "SupplierApproval" && submitted && isTermsId(refId),
    refetchInterval: (q) => waiting(signProgress({ ...base, terms: q.state.data ?? null })),
  });
  // A failed read (other than "no plan yet") is said, never shown as progress; the poll keeps retrying.
  const failed = (e: { code: string } | null) => Boolean(e && e.code !== "NOT_FOUND");
  return { ...signProgress({ ...base, plan: plan.data ?? null, terms: terms.data ?? null }), readFailed: failed(plan.error) || failed(terms.error) };
}

// ---- the stub -----------------------------------------------------------------------------------------------------
const SUBMITTED_TEXT = "Sent. Saving to the public record…";
const FAILED_TEXT = "The blockchain rejected this signature";
/** RCFIX10 W-5: the record now shows another signature (the demo store was rebuilt from another tab); no poll will change that. */
const SUPERSEDED_TEXT = "The demo data changed since you signed. Reload to see it.";

/**
 * What goes inside a money card's stub (DESIGN.md §7; CardShell draws the stub). Pending: "What you're signing: …" in
 * one sentence, the 44 px sign button that opens the thread's SignDialog, and a ghost "What you sign". Then
 * "Sent. Saving to the public record…", then the stamp stub (sign/seal-stub): the chop, who signed and how, when, the
 * stamp code and the clickable tx. The stamp plays only on a live transition after a signature sent from this page, never
 * when history renders. `cta` null = no sign button here (another card in the same reply carries it).
 */
export function SignStub({
  kind,
  refId,
  title,
  summary,
  cta,
  secondary,
}: {
  readonly kind: SignatureKind;
  readonly refId: string;
  readonly title: string;
  readonly summary: string;
  readonly cta: string | null;
  readonly secondary?: ReactNode;
}) {
  const host = useSignHost();
  const progress = useSignProgress(kind, refId);
  const persona = useSession().data?.persona;
  const currency = useDisplayCurrency();
  const key = signKey(kind, refId);
  const openDialog = () => host?.open({ kind, refId, title });
  const sealTx = progress.state === "confirmed" ? progress.txHash : null;
  // This browser's seal only when it carries the tx this page (or, after a reload, this browser) recorded for it.
  const record = host?.submitted(kind, refId);
  const local = ownRecord(record, sealTx);
  useKeepConfirmedTx(key, record, progress);
  const sealing = useSealMoment(Boolean(local));
  const kept = sealTx && !local ? storedSignature(key, sealTx) : undefined;
  // A seal neither signed on this page nor remembered by this browser, while the sample business is on, is the sample's.
  const sample = useSampleBusiness() && progress.state === "confirmed" && !local && !kept;

  return (
    // tabIndex -1: focus lands here after the dialog closes and the sign button is gone.
    <div tabIndex={-1} data-sign-status-key={key} data-testid="sign-status" data-state={progress.state} className="grid w-full min-w-0 gap-3 rounded-md outline-none">
      {progress.state === "idle" || progress.state === "failed" ? (
        <>
          {progress.state === "failed" ? (
            <p role="status" className="text-ui font-medium text-blocked">
              {FAILED_TEXT}. Nothing was paid or changed.
            </p>
          ) : null}
          <p className="text-[0.8125rem] text-pretty text-ink-2">
            <span className="font-medium text-ink">What you’re signing: </span>
            {summary}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {cta ? (
              <SignButton
                busy={false}
                className="min-w-0 flex-[1_1_15rem]"
                icon={progress.state === "failed" ? <RotateCcw aria-hidden /> : undefined}
                onClick={openDialog}
                disabled={!host}
                data-testid="sign-open"
              >
                <span className="truncate">{progress.state === "failed" ? "Sign again" : cta}</span>
              </SignButton>
            ) : null}
            <Button variant="ghost" className="h-10" onClick={openDialog} disabled={!host} data-testid="sign-review">
              <ScrollText aria-hidden /> What you sign
            </Button>
            {secondary}
          </div>
        </>
      ) : progress.state === "submitted" ? (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <LoaderCircle aria-hidden className="size-4 shrink-0 text-ink-3 motion-safe:animate-spin" />
          <p className="text-ui font-medium">{SUBMITTED_TEXT}</p>
          {progress.txHash ? <TxHash hash={progress.txHash} className="ml-auto" /> : null}
          <p className="basis-full text-[0.8125rem] text-pretty text-ink-2">
            {progress.readFailed
              ? "Your signature was sent. Hogee couldn’t check the public record just now. It will keep trying."
              : "Your signature was sent. This updates by itself in a moment, once it’s saved."}
          </p>
        </div>
      ) : progress.state === "superseded" ? (
        <p role="status" className="text-ui font-medium text-pretty">
          {SUPERSEDED_TEXT}
        </p>
      ) : (
        <div role="status" data-testid="sign-confirmed" className="flex items-start gap-2">
          <SealStub
            className="min-w-0 flex-1"
            txHash={progress.txHash}
            signer={signerName(persona)}
            method={local ? local.method : (kept?.method ?? null)}
            signedAt={local ? new Date(local.at).toISOString() : kept?.signedAt}
            currency={currency}
            sealing={sealing}
          />
          {sample ? <SampleSealTag className="mt-2.5" /> : null}
        </div>
      )}
    </div>
  );
}

/** The card's one pill: Waiting on you (dot), Sent, Signed (sunk, with a check), or Out of date (the stub says why). */
export function SignPill({ kind, refId }: { readonly kind: SignatureKind; readonly refId: string }) {
  const { state } = useSignProgress(kind, refId);
  if (state === "confirmed") return <Pill tone="signed">Signed</Pill>;
  if (state === "superseded") return <Pill tone="outline">Out of date</Pill>;
  if (state === "submitted") return <Pill tone="neutral" icon={<Clock aria-hidden />}>Sent</Pill>;
  return <Pill tone="waiting">Waiting on you</Pill>;
}

/** The sign card's tile: waiting (amber) while it is Mei's turn, the seal once Mei signed (cinnabar means just that). */
const signTone = (state: SignState): Tone => (state === "confirmed" ? "seal" : state === "submitted" || state === "superseded" ? "grey" : "waiting");

/** True for the one card waiting on the founder (DESIGN.md §2: only it is lifted). */
export function useLifted(kind: SignatureKind, refId: string): boolean {
  const { waitingKey } = useJourneyThread();
  const { state } = useSignProgress(kind, refId);
  return waitingKey === signKey(kind, refId) && (state === "idle" || state === "failed");
}

// ---- the data-sign card -------------------------------------------------------------------------------------------
const KIND_LINE: Record<SignatureKind, string> = {
  PlanApproval: "Your plan and budget",
  SupplierApproval: "A supplier order and how it is paid",
  MilestoneRelease: "A payment to your supplier",
  LoosenRequest: "A change that makes a rule less strict",
  StageRelease: "The next part of your budget",
  OwnerSpend: "A payment you make yourself",
};

/** The covered row's plain status, after the title: where to sign, or that it is signed (no pointer to another card). */
const ROW_NOTE: Readonly<Record<SignState, string>> = {
  idle: " · sign it with “Sign the plan” above",
  failed: " · sign it with “Sign the plan” above",
  submitted: " · signed with your passkey, now being saved",
  confirmed: " · signed with your passkey",
  superseded: " · the demo data changed since you signed",
};

/**
 * The covered form of a sign card: the same reply's needs card carries "Sign the plan" and "What you sign" for this
 * draft, so the row is kept only as the thread's record of the request (its status for the Next step and the tests),
 * hidden (UX round 3, first-timer #9: no pointer card while the plan card is on screen; one confirmation per signing).
 */
function SignCardRow({ data }: { readonly data: DataSign }) {
  const host = useSignHost();
  const { state } = useSignProgress(data.kind, data.refId);
  const titleId = useId();
  return (
    <section
      hidden
      data-covered="true"
      aria-labelledby={titleId}
      data-testid="card-sign"
      data-kind={data.kind}
      data-ref-id={data.refId}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-card py-1.5 pr-1.5 pl-3 shadow-card"
    >
      <IconTile icon={Fingerprint} tone={signTone(state)} size="sm" />
      <p className="min-w-0 flex-[1_1_12rem] py-1.5 text-ui text-pretty">
        <span id={titleId} className="font-medium">
          {data.title}
        </span>
        <span className="text-ink-2">{ROW_NOTE[state]}</span>
      </p>
      <span data-testid="sign-status" data-state={state}>
        <SignPill kind={data.kind} refId={data.refId} />
      </span>
      <Button variant="ghost" className="h-10" onClick={() => host?.open({ kind: data.kind, refId: data.refId, title: data.title })} disabled={!host} data-testid="sign-review">
        <ScrollText aria-hidden /> What you sign
      </Button>
    </section>
  );
}

/**
 * The inline signature card of a data-sign part. The dialog re-reads the request server-side by refId; the part's
 * text is only the card's wording.
 */
export function SignCard({ data }: CardProps<DataSign>) {
  const covered = useNeedsDraftIdsInMessage();
  const lifted = useLifted(data.kind, data.refId);
  const { state } = useSignProgress(data.kind, data.refId);
  if (data.kind === "PlanApproval" && covered.has(data.refId)) return <SignCardRow data={data} />;
  return (
    <CardShell
      testId="card-sign"
      icon={Fingerprint}
      tone={signTone(state)}
      lifted={lifted}
      data-kind={data.kind}
      data-ref-id={data.refId}
      title={data.title}
      subtitle={KIND_LINE[data.kind]}
      badge={<SignPill kind={data.kind} refId={data.refId} />}
      stub={<SignStub kind={data.kind} refId={data.refId} title={data.title} summary={data.summary} cta={data.cta} />}
    />
  );
}
