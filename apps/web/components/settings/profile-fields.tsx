"use client";

import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Check, OctagonAlert, Palette, Smartphone, type LucideIcon } from "lucide-react";
import { AVATAR_COLOURS, fieldError, saveProfile, type AvatarColour, type Profile, type ProfileCountry, type ProfileTextField, type SaveResult } from "@/lib/profile";
import { cn } from "@/lib/utils";
import { AVATAR_COLOUR_NAME, AVATAR_FILL } from "./profile-avatar";
import { SettingRow } from "./settings-rows";

/** The label column of a field row, so the values line up down a group. */
const LABEL = "w-[7.5rem] shrink-0 text-callout text-ink";

/** What the footer of a group of fields says: the device note, or that the last edit was saved (or kept for now). */
export type SaveStatus = "idle" | SaveResult;

const SAVED_FOR_MS = 2_400;

/** The group's save status. "Saved" shows for a moment after a field is left with a new value; a refusal stays. */
export function useSaveStatus(): readonly [SaveStatus, (result: SaveResult) => void] {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  function report(result: SaveResult) {
    window.clearTimeout(timer.current);
    setStatus(result);
    if (result === "saved") timer.current = window.setTimeout(() => setStatus("idle"), SAVED_FOR_MS);
  }
  return [status, report] as const;
}

/**
 * The footer note under a group of profile fields: where it is saved, and a polite confirmation after an edit. Spans
 * only: it sits inside the group's footer paragraph.
 */
export function SavedNote({ status, children }: { status: SaveStatus; children?: ReactNode }) {
  const stored = status !== "this-page-only";
  return (
    <span className="grid grid-cols-1 gap-1">
      <span role="status" className="flex items-start gap-1.5">
        {status === "saved" ? (
          <>
            <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-paid" />
            <span className="enter-fade">Saved on this device.</span>
          </>
        ) : stored ? (
          <>
            <Smartphone aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>Saved on this device only.</span>
          </>
        ) : (
          <>
            <OctagonAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-blocked" />
            <span className="text-blocked">This browser won&apos;t save it. It lasts until you leave this page.</span>
          </>
        )}
      </span>
      {children}
    </span>
  );
}

type FieldProps = {
  field: ProfileTextField;
  label: string;
  icon: LucideIcon;
  profile: Profile;
  country: ProfileCountry;
  onSaved: (result: SaveResult) => void;
} & Pick<ComponentProps<"input">, "type" | "autoComplete" | "inputMode" | "placeholder" | "autoCapitalize" | "spellCheck">;

/**
 * One editable row, iOS style: the label on the left, the value on the right. A valid value is saved as it is typed
 * (lib/profile.ts writes nothing invalid); the error shows once the field is left, then clears as soon as it is fixed
 * ("reward early, punish late"). Leaving the field with a new value confirms "Saved" in the group's footer.
 */
export function ProfileTextRow({ field, label, icon, profile, country, onSaved, ...input }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const stored = profile[field];
  const [draft, setDraft] = useState(stored);
  const [shown, setShown] = useState(stored);
  const [touched, setTouched] = useState(false);
  const [focused, setFocused] = useState(false);
  const atFocus = useRef(stored);

  // Follow a change made elsewhere (another tab, "Use the demo details") while this field isn't being edited.
  if (stored !== shown) {
    setShown(stored);
    if (!focused) {
      setDraft(stored);
      setTouched(false);
    }
  }

  const error = fieldError(field, draft, country);

  function onChange(value: string) {
    setDraft(value);
    if (!fieldError(field, value, country)) saveProfile({ ...profile, [field]: value }, country);
  }

  function onBlur() {
    setFocused(false);
    setTouched(true);
    if (error) return;
    if (draft.trim() !== atFocus.current.trim()) onSaved(saveProfile({ ...profile, [field]: draft }, country));
  }

  const invalid = touched && Boolean(error);
  return (
    <SettingRow icon={icon} className="transition-[background-color] duration-(--dur-state) ease-settle has-[input:focus-visible]:bg-fill">
      <div className="flex min-h-11 items-center gap-3">
        <label htmlFor={id} className={LABEL}>
          {label}
        </label>
        <input
          id={id}
          name={field}
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => {
            setFocused(true);
            atFocus.current = draft;
          }}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          className={cn(
            "h-11 min-w-0 flex-1 bg-transparent text-right text-callout text-ink caret-ink outline-none placeholder:text-ink-3",
            "aria-invalid:text-blocked",
          )}
          {...input}
        />
      </div>
      {invalid ? (
        <p id={errorId} className="enter-fade -mt-1 flex items-start justify-end gap-1.5 pb-2.5 text-right text-footnote text-blocked">
          <OctagonAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </SettingRow>
  );
}

/** The country: shown, never edited (it comes from this deployment's founder and her plan). */
export function ReadOnlyRow({ icon, label, value, note }: { icon: LucideIcon; label: string; value: string; note: string }) {
  return (
    <SettingRow icon={icon}>
      <div className="flex min-h-11 items-center gap-3">
        <span className={LABEL}>{label}</span>
        <span className="min-w-0 flex-1 text-right text-callout text-ink-3">
          <span>{value}</span>
          <span className="sr-only"> ({note})</span>
        </span>
      </div>
    </SettingRow>
  );
}

/**
 * The avatar colour: five swatches as a native radio group (arrow keys move between them), each a 44 px target around
 * a 28 px swatch (the hit areas meet but never overlap). On the narrowest phones they wrap under the label.
 */
export function ColourRow({ profile, country, onSaved }: { profile: Profile; country: ProfileCountry; onSaved: (result: SaveResult) => void }) {
  const name = useId();
  const labelId = `${name}-label`;
  function choose(colour: AvatarColour) {
    if (colour !== profile.avatarColour) onSaved(saveProfile({ ...profile, avatarColour: colour }, country));
  }
  return (
    <SettingRow icon={Palette}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-3">
        <span id={labelId} className="shrink-0 text-callout text-ink">
          Colour
        </span>
        <div role="radiogroup" aria-labelledby={labelId} className="-mr-2 ml-auto flex items-center">
          {AVATAR_COLOURS.map((colour) => (
            <label key={colour} className="group/swatch relative grid size-11 cursor-pointer place-items-center" title={AVATAR_COLOUR_NAME[colour]}>
              <input
                type="radio"
                name={name}
                value={colour}
                checked={profile.avatarColour === colour}
                onChange={() => choose(colour)}
                aria-label={AVATAR_COLOUR_NAME[colour]}
                className="peer sr-only"
              />
              <span
                aria-hidden
                style={{ backgroundColor: AVATAR_FILL[colour], color: AVATAR_FILL[colour] }}
                className={cn(
                  "grid size-7 place-items-center rounded-full text-ink-on shadow-[inset_0_1px_0_oklch(1_0_0/0.22)]",
                  "transition-[scale,box-shadow] duration-(--dur-state) ease-settle group-hover/swatch:scale-[1.08] group-active/swatch:scale-(--press)",
                  "peer-checked:shadow-[0_0_0_2px_var(--raised),0_0_0_4px_currentColor]",
                  "peer-focus-visible:outline-[3px] peer-focus-visible:outline-offset-[5px] peer-focus-visible:outline-ring/50",
                )}
              >
                <Check className="size-3.5 text-ink-on opacity-0 transition-opacity duration-(--dur-state) group-has-checked/swatch:opacity-100" strokeWidth={3} />
              </span>
            </label>
          ))}
        </div>
      </div>
    </SettingRow>
  );
}
