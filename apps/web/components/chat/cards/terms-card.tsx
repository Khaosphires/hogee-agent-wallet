"use client";

import { useId, useMemo, useState } from "react";
import { Building2, Check, CircleAlert, Handshake, Info, User } from "lucide-react";
import { TERMS_PRESET_MILESTONES, type DataTerms, type MilestoneInput, type OrderTerms, type TermsPreset } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardStub } from "@/components/ui/card";
import { CardHead } from "./card-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill, UnverifiedPill } from "@/components/ui/pill";
import { RadioGroup, RadioGroupItem, RadioGroupSegment, RadioGroupSegmentItem } from "@/components/ui/radio-group";
import { Money } from "@/components/ledger/money";
import { useSubmitOrderTerms, useSupplierSearch } from "@/lib/api/queries";
import { uuidv7 } from "@/lib/chat-session";
import { bu } from "@/lib/format";
import { PRESET_LABELS, PRESET_ORDER, TERMS_ERROR_TEXT, buInputToMinor, previewSchedule, quantityOf, termsErrorOf } from "@/lib/milestone-labels";
import { cn } from "@/lib/utils";
import { HOLDER_HINT, SPLIT_PLAIN, TERMS_TEXT, blockedSplitText, confirmingText, orderSheetTitle, saveAndSign, termsBody } from "./order-copy";
import { ScheduleList, type ScheduleLine } from "./schedule-list";
import { useSignHost } from "./sign-host";
import type { CardProps } from "./types";

type Choice = TermsPreset | "STATED";

/** A split that is possible stays unstruck once the saved form locks (struck means a limit rules it out). */
const LOCKED_ITEM = "disabled:no-underline data-[state=checked]:disabled:text-ink";

const sameSplit = (a: readonly MilestoneInput[], b: readonly MilestoneInput[]): boolean =>
  a.length === b.length && a.every((m, i) => m.bps === b[i]?.bps && m.trigger === b[i]?.trigger);

/** The preset whose split the founder described, if any (then it is that preset, not a separate option). */
const presetOf = (ms: readonly MilestoneInput[]): TermsPreset | null => PRESET_ORDER.find((p) => sameSplit(TERMS_PRESET_MILESTONES[p], ms)) ?? null;

/** The split from her own words (or the button she pressed); nothing is guessed when she said none. */
function initialChoice(data: DataTerms): Choice | null {
  if (data.preset) return data.preset;
  if (data.source !== "founder_text" || !data.milestones) return null;
  return presetOf(data.milestones) ?? "STATED";
}

const splitOf = (ms: readonly MilestoneInput[]): string => ms.map((m) => String(m.bps / 100)).join("/");

/**
 * The deal form (VISION-DECISIONS §9; UX-PLAN D2, D26): the split she agreed (splits a limit rules out are greyed with
 * a grey reason), how many units and the total in BU, and the supplier's bank account she types in. "Save and sign"
 * posts submitOrderTerms (the ONLY way an account reaches the server), and only after the server confirms the terms
 * does it tell the chat `terms_saved` and open the order's sign sheet (two server steps; a failed save opens nothing).
 */
export function TermsCard({ data, answered, act }: CardProps<DataTerms>) {
  const ids = useId();
  const searchId = data.searchId ?? undefined;
  const search = useSupplierSearch(searchId);
  const host = useSignHost();
  const candidate = search.data?.candidates.find((c) => c.supplierId === data.supplierId);
  const [choice, setChoice] = useState<Choice | null>(initialChoice(data));
  const [quantity, setQuantity] = useState("");
  const [total, setTotal] = useState("");
  const [holder, setHolder] = useState("");
  const [bank, setBank] = useState("");
  const [account, setAccount] = useState("");
  const [payeeType, setPayeeType] = useState<"company" | "personal">("company");
  const [saved, setSaved] = useState<OrderTerms | null>(null);
  const submit = useSubmitOrderTerms();

  const availability = new Map(data.presetAvailability.map((p) => [p.preset, p]));
  const milestones: readonly MilestoneInput[] | null = choice === "STATED" ? data.milestones : choice ? TERMS_PRESET_MILESTONES[choice] : null;
  const totalMinor = buInputToMinor(total);
  const qty = quantityOf(quantity);
  const preview = useMemo(() => (milestones ? previewSchedule(totalMinor, milestones) : null), [milestones, totalMinor]);
  const rows: readonly ScheduleLine[] = saved ? saved.schedule : preview && "rows" in preview ? preview.rows : [];
  const autoMinor = rows.filter((r) => r.autoRelease).reduce((s, r) => s + BigInt(r.amountMinor), 0n);
  const heldMinor = rows.filter((r) => !r.autoRelease).reduce((s, r) => s + BigInt(r.amountMinor), 0n);
  const name = candidate?.displayName ?? "this supplier";
  const web = candidate ? candidate.unverified || candidate.origin === "web" : data.searchId !== null;
  const failure = submit.error ? termsErrorOf(submit.error) : null;
  const locked = answered || saved !== null || submit.isPending;
  const ready = Boolean(searchId && milestones && totalMinor && qty && holder.trim().length >= 2 && bank.trim().length >= 2 && /^[0-9]{6,20}$/.test(account));

  const onSubmit = () => {
    if (!ready || !searchId || !milestones || !totalMinor || !qty) return;
    const body = termsBody({ supplierId: data.supplierId, searchId, quantity: qty, totalMinor, milestones, holder, bank, account, payeeType });
    saveAndSign(body, orderSheetTitle(name), {
      save: (b) => submit.mutateAsync({ body: b }),
      act,
      openSheet: (req) => host?.open(req),
      newActionId: uuidv7,
    }).then(setSaved, () => {
      // The refusal is on submit.error, shown above the button; nothing was saved and no sheet opened.
    });
  };

  // After a reload (or once the chat moved on without a save here) the form is closed: the order card below shows any
  // deal the founder saved, with its payments, so a disabled empty form is never left behind.
  if (answered && !saved) {
    return (
      <Card role="region" aria-labelledby={`${ids}-t`} data-testid="card-terms" data-supplier-id={data.supplierId} data-state="closed" className="min-w-0 text-ui">
        <CardHead icon={Handshake} tone="slot-1" titleId={`${ids}-t`} title={<>Your deal with {name}</>} subtitle={TERMS_TEXT.closed} />
      </Card>
    );
  }

  const stated = data.source === "founder_text" && data.milestones && !presetOf(data.milestones) ? data.milestones : null;
  const blocked = PRESET_ORDER.flatMap((p) => {
    const a = availability.get(p);
    return a && !a.ok ? [{ preset: p, text: a.code ? TERMS_ERROR_TEXT[a.code] : "Not possible with your current limits." }] : [];
  });
  const chosenDetail = choice === "STATED" && stated ? `${splitOf(stated)}, as you described it in the chat` : choice && choice !== "STATED" ? PRESET_LABELS[choice].detail : null;
  const options = PRESET_ORDER.length + (stated ? 1 : 0);

  return (
    <Card role="region" aria-labelledby={`${ids}-t`} data-testid="card-terms" data-supplier-id={data.supplierId} lifted={!locked} className="min-w-0 text-ui">
      <CardHead
        icon={Handshake}
        tone={saved ? "slot-1" : "waiting"}
        titleId={`${ids}-t`}
        title={<>Your deal with {name}</>}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {web ? <UnverifiedPill /> : null}
            <span>{saved ? TERMS_TEXT.savedDescription : TERMS_TEXT.description}</span>
          </span>
        }
        badge={
          saved ? (
            <Pill tone="neutral" icon={<Check aria-hidden />}>
              Saved
            </Pill>
          ) : (
            <Pill tone="waiting">Waiting on you</Pill>
          )
        }
      />

      <CardContent className="grid min-w-0 gap-[18px]">
        {!searchId ? (
          <p className="flex items-start gap-2 rounded-lg bg-blocked-wash p-3 text-[0.8125rem] text-blocked" role="alert">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> {TERMS_TEXT.searchGone}
          </p>
        ) : null}

        <fieldset disabled={locked} className="grid min-w-0 gap-2.5">
          <legend className="mb-2 text-meta font-medium text-ink-3">{TERMS_TEXT.splitLegend}</legend>
          {data.question === "DEPOSIT_TRIGGER" ? <p className="text-[0.8125rem] text-ink-2">{TERMS_TEXT.splitAsked}</p> : null}
          {/* disabled on the group too: Radix's roving focus otherwise parks Tab on the group itself once the fieldset locks. */}
          <RadioGroupSegment
            value={choice ?? ""}
            onValueChange={(v) => setChoice(v as Choice)}
            disabled={locked}
            aria-label="Split"
            className={cn(options > 4 && "sm:auto-cols-fr sm:grid-flow-col sm:grid-cols-none")}
          >
            {stated ? (
              <RadioGroupSegmentItem value="STATED" data-preset="STATED" data-available="true" aria-label={`${splitOf(stated)}, as you described`} className={LOCKED_ITEM}>
                {splitOf(stated)}
              </RadioGroupSegmentItem>
            ) : null}
            {PRESET_ORDER.map((p) => {
              const a = availability.get(p);
              const ok = a ? a.ok : true;
              return (
                <RadioGroupSegmentItem
                  key={p}
                  value={p}
                  disabled={!ok}
                  data-preset={p}
                  data-available={String(ok)}
                  aria-label={`${PRESET_LABELS[p].split}: ${PRESET_LABELS[p].detail}`}
                  aria-describedby={ok ? undefined : `${ids}-why-${p}`}
                  className={cn("h-auto min-h-12 py-1.5 leading-tight whitespace-normal", ok && LOCKED_ITEM)}
                >
                  {/* The split, and under it in plain words what is paid when (the accessible name says it in full). */}
                  <span className="grid gap-0.5">
                    <span>{PRESET_LABELS[p].split}</span>
                    <span className="text-caption font-normal text-pretty text-ink-3">{SPLIT_PLAIN[p]}</span>
                  </span>
                </RadioGroupSegmentItem>
              );
            })}
          </RadioGroupSegment>
          <p className="text-[0.8125rem] text-ink-2" aria-live="polite">
            {chosenDetail ?? TERMS_TEXT.splitHelp}
          </p>
          {blocked.length > 0 ? (
            <ul className="grid gap-1" data-testid="blocked-splits">
              {blocked.map((b) => (
                <li key={b.preset} id={`${ids}-why-${b.preset}`} className="text-[0.78125rem] leading-[1.45] text-ink-3">
                  {blockedSplitText(PRESET_LABELS[b.preset].split, b.text)}
                </li>
              ))}
            </ul>
          ) : null}
        </fieldset>

        <fieldset disabled={locked} className="grid min-w-0 gap-3 sm:grid-cols-2">
          <legend className="sr-only">Order</legend>
          <div className="grid content-start gap-1.5">
            <Label htmlFor={`${ids}-q`}>{TERMS_TEXT.quantity}</Label>
            <Input id={`${ids}-q`} className="h-10" inputMode="numeric" autoComplete="off" value={quantity} placeholder="e.g. 600" onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor={`${ids}-total`}>{TERMS_TEXT.total}</Label>
            <Input id={`${ids}-total`} className="h-10" inputMode="numeric" autoComplete="off" value={total} placeholder="e.g. 2500" onChange={(e) => setTotal(e.target.value)} aria-describedby={`${ids}-total-h`} />
            <p id={`${ids}-total-h`} className="text-meta text-ink-3">
              {TERMS_TEXT.totalHelp}
            </p>
          </div>
        </fieldset>

        <fieldset disabled={locked} className="grid min-w-0 gap-3">
          <legend className="mb-1 text-meta font-medium text-ink-3">{TERMS_TEXT.accountLegend}</legend>
          <p className="flex items-start gap-2 text-[0.8125rem] text-ink-2">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" /> {TERMS_TEXT.accountAsk}
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor={`${ids}-holder`}>{TERMS_TEXT.holder}</Label>
            <Input
              id={`${ids}-holder`}
              className="h-10"
              autoComplete="off"
              value={holder}
              onChange={(e) => setHolder(e.target.value)}
              maxLength={120}
              aria-describedby={`${ids}-holder-h`}
            />
            <p id={`${ids}-holder-h`} className="text-meta text-pretty text-ink-3">
              {HOLDER_HINT}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-bank`}>{TERMS_TEXT.bank}</Label>
              <Input id={`${ids}-bank`} className="h-10" autoComplete="off" value={bank} onChange={(e) => setBank(e.target.value)} maxLength={80} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${ids}-acct`}>{TERMS_TEXT.account}</Label>
              <Input id={`${ids}-acct`} className="h-10 font-mono" inputMode="numeric" autoComplete="off" value={account} onChange={(e) => setAccount(e.target.value.replace(/\s/g, ""))} maxLength={20} />
            </div>
          </div>
          <RadioGroup value={payeeType} onValueChange={(v) => setPayeeType(v as "company" | "personal")} disabled={locked} className="flex flex-wrap gap-x-5 gap-y-1" aria-label={TERMS_TEXT.accountType}>
            {(["company", "personal"] as const).map((t) => (
              <div key={t} className="flex min-h-10 items-center gap-2.5">
                <RadioGroupItem id={`${ids}-${t}`} value={t} />
                <Label htmlFor={`${ids}-${t}`}>
                  {t === "company" ? <Building2 aria-hidden className="size-4 text-ink-3" /> : <User aria-hidden className="size-4 text-ink-3" />}
                  {t === "company" ? TERMS_TEXT.company : TERMS_TEXT.personal}
                </Label>
              </div>
            ))}
          </RadioGroup>
          <p className="text-meta text-ink-3">{TERMS_TEXT.practice}</p>
        </fieldset>

        <div className="grid gap-2.5">
          <p className="text-meta font-medium text-ink-3">{saved ? TERMS_TEXT.schedule : TERMS_TEXT.preview}</p>
          {rows.length > 0 ? (
            <ScheduleList rows={rows} />
          ) : (
            <p className="text-[0.8125rem] text-ink-2">{preview && "code" in preview && total ? TERMS_ERROR_TEXT[preview.code] : TERMS_TEXT.previewEmpty}</p>
          )}
          {rows.length > 0 ? (
            <p className="mt-1 flex flex-wrap justify-between gap-x-4 gap-y-1.5 border-t border-line pt-3.5 text-[0.8125rem] text-ink-2">
              <span>
                {TERMS_TEXT.autoTotal} <Money minor={autoMinor.toString()} className="font-medium text-ink" />
              </span>
              <span>
                {TERMS_TEXT.heldTotal} <Money minor={heldMinor.toString()} className="font-medium text-ink" />
              </span>
            </p>
          ) : null}
        </div>
      </CardContent>

      <CardStub className="mt-1">
        {saved ? (
          <p className="text-[0.8125rem] text-pretty text-ink-2">
            <strong className="font-medium text-ink">{TERMS_TEXT.nextAfterSave}</strong> {TERMS_TEXT.nextAfterSaveBody}
          </p>
        ) : (
          <div className="grid w-full min-w-0 gap-3">
            {rows.length > 0 ? (
              <p className="max-w-[60ch] text-[0.8125rem] text-pretty text-ink-2" data-testid="terms-confirming">
                <strong className="font-medium text-ink">What you&apos;re saving: </strong>
                {confirmingText(name, bu(autoMinor.toString()), bu(heldMinor.toString()))}
              </p>
            ) : null}
            {failure ? (
              <p role="alert" data-testid="terms-error" data-code={failure.code ?? ""} className="flex items-start gap-2 rounded-lg bg-blocked-wash p-3 text-[0.8125rem] text-blocked">
                <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> {failure.text}
              </p>
            ) : null}
            <Button type="button" size="lg" data-testid="terms-submit" className="w-full sm:w-fit" disabled={!ready || locked || !host} onClick={onSubmit}>
              {submit.isPending ? TERMS_TEXT.saving : TERMS_TEXT.save}
            </Button>
          </div>
        )}
      </CardStub>
    </Card>
  );
}
