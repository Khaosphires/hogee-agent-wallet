"use client";

import { useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { CircleCheck, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ALREADY_ON_DEVICE, CODE_SHAPE_TEXT, RegistrationFailure, alreadyOnDevice, isEnrolmentCode, normalizeEnrolmentCode, registrationErrorText } from "@/lib/enrolment";
import { PASSKEY_EVENT, passkeysSupported, registerFounderPasskey, storedCredentialId } from "@/lib/passkey";

/**
 * Passkey set-up first (UX-PLAN D1): the founder creates a passkey at the welcome step, with the same one-time code
 * from the loan officer, the same expiry and the same officer registration as the sign sheet's enrolment (G5). It never
 * blocks intake: "Later" hides it, and the sign sheet keeps enrolment as the fallback.
 */

export { PASSKEY_EVENT };
const DISMISSED_KEY = "hogee.passkeySetup.dismissed";

const announce = (): void => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PASSKEY_EVENT));
};

/** True once the founder pressed "Later" on this browser (a convenience only: storage may be unavailable). */
export function passkeySetupDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissPasskeySetup(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage unavailable: the card hides for this page view only.
  }
  announce();
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(PASSKEY_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PASSKEY_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** True when this browser holds the founder's passkey id (set after a registration or a signature). */
export function usePasskeyOnDevice(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => Boolean(storedCredentialId()),
    () => false,
  );
}

const usePasskeySetupDismissed = (): boolean => useSyncExternalStore(subscribe, passkeySetupDismissed, () => false);

const never = (): (() => void) => () => undefined;
/** Whether this browser can make passkeys; assumed yes on the server, so the form never flashes a refusal. */
const usePasskeysSupported = (): boolean => useSyncExternalStore(never, passkeysSupported, () => true);

/** Scrolls to the passkey card and puts the cursor in its code field (the Next step bar's "Set up passkey"). */
export function focusPasskeySetup(): void {
  const card = document.querySelector<HTMLElement>('[data-testid="passkey-setup"]');
  if (!card) return;
  card.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  card.querySelector<HTMLInputElement>("input[name='enrolment-code']")?.focus({ preventScroll: true });
}

/** "…q1Y8": the last four characters of the passkey ID, which the loan officer's console shows too. */
export const passkeyIdSuffix = (credentialId: string): string => `…${credentialId.slice(-4)}`;

export function PasskeySetupCard({ onDone, onLater }: { onDone?: () => void; onLater?: () => void }) {
  const onDevice = usePasskeyOnDevice();
  const dismissed = usePasskeySetupDismissed();
  const [createdId, setCreatedId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  if (createdId || notice) return <PasskeyCreated credentialId={createdId} notice={notice} />;
  if (onDevice || dismissed) return null;
  return (
    <PasskeySetupForm
      onCreated={(id) => {
        setCreatedId(id);
        announce();
        onDone?.();
      }}
      onAlreadyOnDevice={() => {
        setNotice(ALREADY_ON_DEVICE);
        announce();
        onDone?.();
      }}
      onLater={() => {
        dismissPasskeySetup();
        onLater?.();
      }}
    />
  );
}

function PasskeyCreated({ credentialId, notice }: { credentialId?: string; notice?: string }) {
  return (
    <Card data-testid="passkey-setup" data-state="done" role="status" className="min-w-0 text-ui">
      <CardContent className="flex items-start gap-3">
        <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-paid" />
        <p className="text-pretty text-ink-2">
          {credentialId ? (
            <>
              <span className="font-medium text-ink">Passkey created on this device.</span> Your passkey ID ends in{" "}
              <span className="font-mono text-[0.78125rem] text-ink" data-testid="passkey-id-suffix">
                {passkeyIdSuffix(credentialId)}
              </span>
              . Your loan officer checks it before you can sign.
            </>
          ) : (
            notice
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function PasskeySetupForm({ onCreated, onAlreadyOnDevice, onLater }: { onCreated: (credentialId: string) => void; onAlreadyOnDevice: () => void; onLater: () => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const supported = usePasskeysSupported();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const clean = normalizeEnrolmentCode(code);
    if (!isEnrolmentCode(clean)) {
      setError(CODE_SHAPE_TEXT);
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await registerFounderPasskey(clean);
      onCreated(result.credentialId);
    } catch (err) {
      if (err instanceof RegistrationFailure && alreadyOnDevice(err)) {
        onAlreadyOnDevice();
        return;
      }
      setError(err instanceof RegistrationFailure ? registrationErrorText(err.step, err.error) : String(err));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card role="region" aria-labelledby={`${id}-title`} data-testid="passkey-setup" data-state="form" className="min-w-0 text-ui">
      <CardHeader>
        <CardTitle>
          <h3 id={`${id}-title`} className="flex items-center gap-2">
            <KeyRound aria-hidden className="size-4 text-ink-2" /> First, set up your passkey
          </h3>
        </CardTitle>
        <CardDescription>A passkey is how you approve things with your fingerprint, face or phone PIN, like Touch ID.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-3" aria-labelledby={`${id}-title`}>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-code`}>Set-up code from your loan officer</Label>
            <Input
              ref={input}
              id={`${id}-code`}
              name="enrolment-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setError(undefined);
              }}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={64}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
              className="font-mono tracking-wider md:text-[0.875rem]"
              disabled={busy}
            />
            <p id={`${id}-hint`} className="text-meta text-ink-3">
              Ask your loan officer for it. It works once, and only for 15 minutes.
            </p>
            {error ? (
              <p id={`${id}-error`} className="text-[0.8125rem] text-pretty text-blocked" role="alert" data-testid="enrolment-error">
                {error}
              </p>
            ) : null}
            {supported ? null : <p className="text-[0.8125rem] text-pretty text-blocked">This browser can&apos;t make passkeys. Try Safari, Chrome or Edge.</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy || !supported}>
              <KeyRound /> {busy ? "Waiting for your device…" : "Create passkey"}
            </Button>
            <Button type="button" variant="ghost" onClick={onLater} disabled={busy}>
              Later
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
