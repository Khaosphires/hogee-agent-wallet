"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Copy, KeyRound, ShieldCheck, X } from "lucide-react";
import { errorCopy, type PendingFounderKey } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { HexValue, TxHash } from "@/components/ledger/hash";
import type { ApiClientError } from "@/lib/api/client";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/use-session";
import { founderKeyErrorText, timeLeft } from "@/lib/enrolment";
import { isoDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const COPIED_MS = 2_000;
// Icon cross-fade (both icons stay in the DOM): opacity, scale and blur, interruptible CSS transitions.
const ICON = "absolute inset-0 size-4 transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";
const ICON_ON = "scale-100 opacity-100 blur-0";
const ICON_OFF = "scale-25 opacity-0 blur-[4px]";

/**
 * The last four characters of a passkey ID, as Mei's screen shows them (ux-sign `passkeyIdSuffix`): "…" plus the
 * credential id's last 4 characters, case-sensitive. Both screens read the same credentialId (G5: an added check).
 */
export const passkeyIdSuffix = (credentialId: string): string => `…${credentialId.slice(-4)}`;

function Failure({ text }: { text: string }) {
  return (
    <p className="text-[0.8125rem] text-pretty text-blocked" role="alert">
      {text}
    </p>
  );
}

/** A done result: "Done. Receipt: 0x1e3c…" (REWRITES B6), or, before the chain answers, that it is being saved. */
export function Receipt({ txHash }: { txHash?: string }) {
  return (
    <p className="text-[0.8125rem] text-ink-2" role="status">
      {txHash ? (
        <>
          Done. Receipt: <TxHash hash={txHash} />
        </>
      ) : (
        "Done. It's being saved to the blockchain."
      )}
    </p>
  );
}

/** 24 characters in four groups of six for reading aloud; the text itself has no spaces, so selecting it copies the code. */
function CodeGroups({ code }: { code: string }) {
  const groups = code.match(/.{1,6}/g) ?? [code];
  return (
    <code data-testid="enrolment-code" className="flex flex-wrap gap-x-2 font-mono text-[1.0625rem] font-medium tracking-wider text-ink tabular-nums select-all">
      {groups.map((g, i) => (
        <span key={i}>{g}</span>
      ))}
    </code>
  );
}

function CopyButton({ code }: { code: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<"yes" | "failed">();
  // The code is shown once: put focus on Copy so a keyboard user can take it straight away.
  useEffect(() => button.current?.focus(), []);
  useEffect(() => {
    if (copied !== "yes") return;
    const t = setTimeout(() => setCopied(undefined), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);

  function copy() {
    navigator.clipboard
      .writeText(code)
      .then(() => setCopied("yes"))
      .catch(() => setCopied("failed"));
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button ref={button} type="button" size="sm" onClick={copy}>
        <span aria-hidden className="relative size-4">
          <Copy className={cn(ICON, copied === "yes" ? ICON_OFF : ICON_ON)} />
          <Check className={cn(ICON, copied === "yes" ? ICON_ON : ICON_OFF)} />
        </span>
        {copied === "yes" ? "Copied" : "Copy code"}
      </Button>
      <span role="status" className="sr-only">
        {copied === "yes" ? "Set-up code copied" : ""}
      </span>
      {copied === "failed" ? <p className="text-meta text-blocked">Couldn&apos;t copy. Select the code and copy it yourself.</p> : null}
    </div>
  );
}

/** The new code, shown once with its time left; gone when hidden, expired, or once the founder's key arrives. */
function OneTimeCode({ code, expiresAt, founder, onHide }: { code: string; expiresAt: string; founder: string; onHide: () => void }) {
  // The shared ticker can be up to a second stale on first render: never count from before the code was shown.
  const [shownAt] = useState(() => Date.now());
  const left = timeLeft(expiresAt, Math.max(useNow(), shownAt));
  if (!left) {
    return (
      <p className="text-[0.8125rem] text-ink-2" role="status" data-testid="enrolment-code-expired">
        The code ran out at {isoDateTime(expiresAt)}. Make a new one when {founder} is ready.
      </p>
    );
  }
  return (
    <section aria-label="Set-up code" data-testid="one-time-code" className="grid gap-3 rounded-[10px] bg-raised p-3.5 shadow-[0_0_0_1.5px_var(--ink)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <CodeGroups code={code} />
        <CopyButton code={code} />
      </div>
      <p className="text-meta text-ink-3">
        Expires {isoDateTime(expiresAt)} · <span className="font-mono text-[0.78125rem] font-medium text-ink tabular-nums">{left}</span> left
      </p>
      <p className="text-meta text-pretty text-ink-2">
        You&apos;ll only see this code once. Give it to {founder} yourself, in person or by phone. Upper and lower case matter. Making a new code
        cancels this one.
      </p>
      <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={onHide}>
        Hide code
      </Button>
    </section>
  );
}

/** Everything steps 2 and 3 share: the pending key (read every 1.5 s) and the three officer actions. */
export function useFounderEnrolment() {
  const session = useSession();
  const isOfficer = session.data?.persona === "officer";
  const pending = useApiQuery("getPendingFounderKey", undefined, { enabled: isOfficer });
  const generate = useApiMutation("issueEnrolmentCode");
  const approve = useApiMutation("approveFounderKey");
  const reject = useApiMutation("rejectFounderKey");
  const pendingKey = pending.data;
  // A key arriving means the code was used: forget it, so it never shows again once that key is approved or rejected.
  const forgetCode = generate.reset;
  useEffect(() => {
    if (pendingKey) forgetCode();
  }, [pendingKey, forgetCode]);
  return { session, pending, pendingKey, generate, approve, reject };
}

export type FounderEnrolmentState = ReturnType<typeof useFounderEnrolment>;

const errorText = (action: "generate" | "approve" | "reject", error: ApiClientError | null): string | undefined =>
  error ? founderKeyErrorText(action, error) : undefined;

/**
 * Step 2: give the founder a one-time set-up code (G2; docs/G2-notes-for-P2.md §2). The button stays whenever no key
 * waits for review (a new code cancels the old one); a key waiting for review blocks a new code, and so does not
 * knowing yet (fail closed). Its label is pinned by the e2e helpers and the demo recorder.
 */
export function CodeStepBody({ e, founder, primary, show }: { e: FounderEnrolmentState; founder: string; primary: boolean; show: boolean }) {
  const { pendingKey, generate, approve, reject } = e;
  const canGenerate = pendingKey === null && !generate.isPending;
  const generateError = errorText("generate", generate.error);
  if (!show && !generate.data && !generateError) return null;
  return (
    <div className="grid justify-items-start gap-2.5">
      {show ? (
        <Button
          type="button"
          variant={primary ? "default" : "secondary"}
          disabled={!canGenerate}
          onClick={() => {
            approve.reset();
            reject.reset();
            generate.mutate(undefined);
          }}
        >
          <KeyRound /> Generate enrolment code
        </Button>
      ) : null}
      {generateError ? <Failure text={generateError} /> : null}
      {generate.data && pendingKey === null ? (
        <OneTimeCode code={generate.data.code} expiresAt={generate.data.expiresAt} founder={founder} onHide={() => generate.reset()} />
      ) : null}
    </div>
  );
}

/** The key under review: the short passkey ID to compare with the founder's screen, details folded, Approve and a confirmed Reject. */
function PendingKeyCard({
  pendingKey,
  founder,
  busy,
  onApprove,
  onReject,
}: {
  pendingKey: PendingFounderKey;
  founder: string;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);

  return (
    <div className="grid gap-3" data-testid="pending-founder-key">
      <div className="grid gap-2 rounded-[10px] bg-sunk p-3.5">
        <p className="flex flex-wrap items-baseline gap-x-2 text-ui text-ink" data-testid="passkey-id-suffix">
          {founder}&apos;s passkey ID ends in
          <span className="font-mono text-[1.0625rem] font-semibold tracking-wider text-ink">{passkeyIdSuffix(pendingKey.credentialId)}</span>
        </p>
        <p className="text-meta text-pretty text-ink-2">
          {founder}&apos;s screen shows the same four characters (upper and lower case matter). Approve only if they match. Each loan can have only one
          founder passkey.
        </p>
        <details className="group/details text-meta">
          <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md font-medium text-ink-2 outline-none select-none hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-3.5 transition-[rotate] duration-(--dur-state) ease-settle group-open/details:rotate-90" />
            Show technical details
          </summary>
          <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            <dt className="text-ink-3">Passkey ID</dt>
            <dd>
              <HexValue value={pendingKey.credentialId} full />
            </dd>
            <dt className="text-ink-3">Public key (x)</dt>
            <dd>
              <HexValue value={pendingKey.qx} />
            </dd>
            <dt className="text-ink-3">Public key (y)</dt>
            <dd>
              <HexValue value={pendingKey.qy} />
            </dd>
            <dt className="text-ink-3">Created</dt>
            <dd className="tabular-nums">{isoDateTime(pendingKey.createdAt)}</dd>
          </dl>
        </details>
      </div>
      {confirming ? (
        <div role="group" aria-label="Confirm the rejection" className="grid gap-2 rounded-[10px] bg-blocked-wash p-3.5">
          <p className="text-ui font-semibold text-blocked">Reject this passkey?</p>
          <p className="text-meta text-pretty text-ink-2">It can never be approved later. {founder} will need a new set-up code.</p>
          <div className="flex flex-wrap gap-2">
            <Button ref={keep} type="button" variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
              Keep it
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={onReject} disabled={busy}>
              <X /> Reject passkey
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onApprove} disabled={busy}>
            <ShieldCheck /> Approve {founder}&apos;s passkey
          </Button>
          <Button type="button" variant="ghost" className="text-blocked hover:bg-blocked-wash hover:text-blocked" onClick={() => setConfirming(true)} disabled={busy}>
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

/** Step 3: approve the founder's passkey (registerFounderKey, signed by the demo lender key) or reject it. */
export function PasskeyStepBody({ e, founder }: { e: FounderEnrolmentState; founder: string }) {
  const { session, pending, pendingKey, approve, reject } = e;
  const reviewError = errorText("approve", approve.error) ?? errorText("reject", reject.error);
  const busy = approve.isPending || reject.isPending || !session.data;
  return (
    <>
      {pending.error ? <Failure text={`${errorCopy(pending.error.code).title}: ${pending.error.message}`} /> : null}
      {pendingKey ? (
        <PendingKeyCard
          key={pendingKey.credentialId}
          pendingKey={pendingKey}
          founder={founder}
          busy={busy}
          onApprove={() =>
            session.data &&
            approve.mutate({ body: { founderId: session.data.founderId, credentialId: pendingKey.credentialId, qx: pendingKey.qx, qy: pendingKey.qy } })
          }
          onReject={() => reject.mutate({ body: { credentialId: pendingKey.credentialId } })}
        />
      ) : null}
      {reviewError ? <Failure text={reviewError} /> : null}
      {approve.data?.txHash ? <Receipt txHash={approve.data.txHash} /> : null}
      {reject.isSuccess && pendingKey === null ? (
        <p className="text-[0.8125rem] text-ink-2" role="status" data-testid="key-rejected">
          Rejected. {founder} needs a new set-up code to try again.
        </p>
      ) : null}
    </>
  );
}
