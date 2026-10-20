"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CODE_SHAPE_TEXT, isEnrolmentCode, normalizeEnrolmentCode } from "@/lib/enrolment";

/**
 * The founder's half of passkey enrolment (G2): the one-time code from the loan officer, checked for shape here so a
 * typo never reaches the API. The code lives only in this form's state and is gone once the form closes.
 */
export function EnrolmentForm({
  title,
  busy,
  error,
  onSubmit,
  onCancel,
  onEdit,
}: {
  title: string;
  busy: boolean;
  /** Why the last attempt failed (server or device), shown under the field. */
  error?: string;
  onSubmit: (code: string) => void;
  onCancel: () => void;
  /** The founder changed the code: the last attempt's error no longer applies. */
  onEdit: () => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [shapeError, setShapeError] = useState<string>();
  const shown = shapeError ?? error;

  // The button that opened this form is gone: put focus where the founder types next.
  useEffect(() => input.current?.focus(), []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const clean = normalizeEnrolmentCode(code);
    if (!isEnrolmentCode(clean)) {
      setShapeError(CODE_SHAPE_TEXT);
      input.current?.focus();
      return;
    }
    onSubmit(clean);
  }

  return (
    <form onSubmit={submit} aria-labelledby={`${id}-title`} className="grid gap-4 rounded-lg bg-sunk p-4 shadow-[inset_0_0_0_1px_var(--line)]" data-testid="enrolment-form">
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-raised text-ink shadow-[0_0_0_1px_var(--line)]">
          <KeyRound className="size-4" />
        </span>
        <div className="space-y-1">
          <p id={`${id}-title`} className="text-title">
            {title}
          </p>
          <p className="text-[0.8125rem] text-pretty text-ink-2">
            A passkey is how you approve things with your fingerprint, face or phone PIN, like Touch ID. Ask your loan officer for a set-up code. It works once, and only for 15 minutes.
          </p>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-code`}>Set-up code from your loan officer</Label>
        <Input
          ref={input}
          id={`${id}-code`}
          name="enrolment-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setShapeError(undefined);
            onEdit();
          }}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={64}
          aria-invalid={shown ? true : undefined}
          aria-describedby={shown ? `${id}-hint ${id}-error` : `${id}-hint`}
          className="font-mono tracking-wider md:text-[0.875rem]"
          disabled={busy}
        />
        <p id={`${id}-hint`} className="text-meta text-ink-3">
          24 letters or numbers (it can also have - or _). Spaces are fine.
        </p>
        {shown ? (
          <p id={`${id}-error`} className="text-[0.8125rem] text-pretty text-blocked" role="alert" data-testid="enrolment-error">
            {shown}
          </p>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Not now
        </Button>
        <Button type="submit" disabled={busy}>
          <KeyRound /> {busy ? "Waiting for your device…" : "Create passkey"}
        </Button>
      </div>
    </form>
  );
}
