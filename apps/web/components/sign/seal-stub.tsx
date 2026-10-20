"use client";

import { useEffect, useState } from "react";
import { TxHash } from "@/components/ledger/hash";
import { Seal, SealCode } from "@/components/ledger/seal";
import { cn } from "@/lib/utils";
import { sealSignerLine, sealTime } from "./seal-time";

/** How long the seal moment runs (DESIGN.md §4: ≤ 600 ms of motion; the flag drops just after it ends). */
export const SEAL_MOMENT_MS = 650;

/**
 * True for SEAL_MOMENT_MS after `signed` turns from false to true while mounted: the live transition to signed.
 * Never true on the first render, so history (a card that mounts already signed) never replays the stamp.
 */
export function useSealMoment(signed: boolean): boolean {
  const [last, setLast] = useState(signed);
  const [sealing, setSealing] = useState(false);
  if (last !== signed) {
    setLast(signed);
    setSealing(signed);
  }
  useEffect(() => {
    if (!sealing) return;
    const t = setTimeout(() => setSealing(false), SEAL_MOMENT_MS);
    return () => clearTimeout(t);
  }, [sealing]);
  return sealing;
}

/**
 * The signed state of a stub (DESIGN.md §4, §7): the 40 px chop with the seal code, "Signed by Mei with a passkey",
 * the time in the facility's zone with "stamp C21E", and the tx link. Put it inside <CardStub> on a money card, or on
 * its own (the sign dialog). Before the transaction exists it says when it will appear instead of an empty slot.
 *
 * `sealing` plays the stamp (globals.css: the chop's stamp and bleed, then the signer line at 300 ms and the tx at
 * 360 ms; transform and opacity only; a 120 ms fade under reduced motion). Drive it with useSealMoment(signed) so it
 * runs only on a live transition, never when history renders.
 *
 *   const sealing = useSealMoment(Boolean(action));
 *   <CardStub><SealStub txHash={action?.txHash} signer="Mei" signedAt={at} currency="SGD" sealing={sealing} /></CardStub>
 */
export function SealStub({
  txHash,
  signer,
  method = "passkey",
  signedAt,
  currency,
  sealing = false,
  className,
}: {
  txHash?: string | null;
  /** Who signed; null when no name is known ("Signed with a passkey"). */
  signer: string | null;
  /** How the signer signed; null when this page doesn't know (a signature read back from history). */
  method?: "passkey" | "wallet" | null;
  /** ISO-8601; shown as "19 Oct, 14:02 SGT". */
  signedAt?: string;
  /** The facility currency, which picks the time zone. */
  currency?: string;
  sealing?: boolean;
  className?: string;
}) {
  const when = signedAt ? sealTime(signedAt, currency) : null;
  return (
    <div data-slot="seal-stub" data-sealing={sealing ? "true" : undefined} className={cn("flex w-full flex-wrap items-center gap-x-3.5 gap-y-3", className)}>
      <Seal txHash={txHash} />
      <p data-seal-line="signer" className="min-w-0 flex-[1_1_220px] text-[0.8125rem] leading-[1.45] text-ink-2">
        <strong className="block text-ui font-medium text-ink">{sealSignerLine(signer, method)}</strong>
        {[when, txHash ? <SealCode key="code" txHash={txHash} /> : null].filter(Boolean).map((part, i) => (
          <span key={i}>
            {i > 0 ? " · " : null}
            {part}
          </span>
        ))}
      </p>
      <span data-seal-line="tx" className="text-[0.78125rem] text-ink-3">
        {txHash ? <TxHash hash={txHash} /> : "The receipt link shows here once it’s sent."}
      </span>
    </div>
  );
}
