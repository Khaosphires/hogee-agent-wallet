"use client";

import { createContext, useContext, useState, type FormEvent, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SquareTerminal } from "lucide-react";
import { Persona } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ApiClientError } from "@/lib/api/client";
import { founderChange, type PersonaChange } from "@/lib/api/session";
import { useSession, useSetPersona } from "@/lib/api/use-session";
import { PERSONA_LABEL, isFounderPersona, personaOptions } from "@/lib/persona";
import { cn } from "@/lib/utils";
import { homeFor, isRouteVisibleFor } from "./routes";

function personaError(error: ApiClientError | null): string | undefined {
  if (!error) return undefined;
  if (error.code === "NOT_FOUND") return "Switching people is off in this version.";
  if (error.code === "FORBIDDEN") return "That access code isn't accepted.";
  if (error.code === "VALIDATION") return "Enter the officer access code (32 characters or more).";
  return error.message;
}

interface PersonaSwitchValue {
  /** Switch to `persona`: a founder at once, the officer through the access-code dialog (the server checks the code). */
  readonly choose: (persona: Persona) => void;
  readonly pending: boolean;
  /** Why the last switch failed, outside the dialog. */
  readonly error?: string;
}

const PersonaSwitchContext = createContext<PersonaSwitchValue | null>(null);

function usePersonaSwitch(): PersonaSwitchValue {
  const value = useContext(PersonaSwitchContext);
  if (!value) throw new Error("PersonaSwitch needs a PersonaSwitchProvider (app-shell.tsx)");
  return value;
}

/**
 * Who you are in the demo (UX-PLAN D12). One provider for the whole shell, so the Demo menu (top bar) and the menu
 * sheet (phone) share one officer access-code dialog, and it outlives the popover or sheet that opened it. The check
 * is the server's, unchanged: POST /api/session/persona with the code; the browser never decides who is the officer.
 */
export function PersonaSwitchProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const setPersona = useSetPersona();
  const [askCode, setAskCode] = useState(false);
  const [code, setCode] = useState("");
  const [refused, setRefused] = useState<string>();

  function change(next: PersonaChange) {
    setRefused(undefined);
    setPersona.mutate(next, {
      onSuccess: () => {
        setAskCode(false);
        setCode("");
        if (!isRouteVisibleFor(pathname, next.persona)) router.push(homeFor(next.persona));
      },
    });
  }

  function choose(persona: Persona) {
    if (isFounderPersona(persona)) {
      const body = founderChange(persona);
      if (body) change(body);
      else setRefused(`${PERSONA_LABEL[persona]} can't be selected in this version.`);
      return;
    }
    setPersona.reset();
    setAskCode(true);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    change({ persona: "officer", officerToken: code });
  }

  function onOpenChange(open: boolean) {
    setAskCode(open);
    // The code never outlives the dialog: closed means blanked.
    if (!open) setCode("");
  }

  const error = personaError(setPersona.error) ?? refused;
  const value: PersonaSwitchValue = { choose, pending: setPersona.isPending, error: askCode ? undefined : error };

  return (
    <PersonaSwitchContext.Provider value={value}>
      {children}
      <Dialog open={askCode} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={onSubmit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Switch to the loan officer</DialogTitle>
              <DialogDescription>The loan officer can approve and send money, so this needs the officer access code.</DialogDescription>
            </DialogHeader>
            <OfficerCodeField code={code} onCode={setCode} error={error} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={setPersona.isPending || code.length === 0}>
                Switch
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PersonaSwitchContext.Provider>
  );
}

/**
 * The code field of the officer dialog. It reads the session itself, and only while the dialog is open: the provider
 * above every page must not re-render when the session loads, or React client-renders the page's still-streaming
 * Suspense boundary (a context change it can't see into) and the streamed copy is left behind, hidden.
 */
function OfficerCodeField({ code, onCode, error }: { code: string; onCode: (code: string) => void; error?: string }) {
  const { data: session } = useSession();
  // Where a judge finds the code in a demo run (friction log #14): never the code itself, and never in live mode,
  // where the code is the real operator's.
  const demo = session !== undefined && session.mode !== "live";
  return (
    <div className="grid gap-2">
      <Label htmlFor="officer-code">Officer access code</Label>
      <Input
        id="officer-code"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={code}
        onChange={(e) => onCode(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? "officer-code-error" : "", demo ? "officer-code-hint" : ""].filter(Boolean).join(" ") || undefined}
      />
      {error ? (
        <p id="officer-code-error" className="text-[0.8125rem] text-blocked">
          {error}
        </p>
      ) : null}
      {demo ? (
        <p id="officer-code-hint" data-testid="officer-code-hint" className="flex items-start gap-1.5 text-footnote text-pretty text-ink-3">
          <SquareTerminal aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Demo: the access code is printed in the terminal where the app was started.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The "View as" choice: a radiogroup (its accessible name stays "Persona"; e2e and the demo recorder use it) of this
 * deployment's founder and the loan officer. `onChose` lets the menu or sheet that holds it close first.
 */
export function PersonaRadios({ className, onChose }: { className?: string; onChose?: (persona: Persona) => void }) {
  const { data: session } = useSession();
  const { choose, pending, error } = usePersonaSwitch();
  // Only this deployment's founder: the API refuses the other country's founder (SG-DECISIONS Q1).
  const options = session ? personaOptions(session) : [];

  function onValueChange(value: string) {
    const parsed = Persona.safeParse(value);
    // Radix sends "" when the active item is clicked again; keep the current persona.
    if (!parsed.success || parsed.data === session?.persona) return;
    onChose?.(parsed.data);
    choose(parsed.data);
  }

  if (options.length === 0) return <Skeleton aria-hidden className={cn("h-10 w-48 rounded-lg", className)} />;
  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-label="Persona"
        className={cn("w-full", className)}
        value={session?.persona ?? ""}
        onValueChange={onValueChange}
        disabled={pending}
      >
        {options.map((persona) => (
          // 34 px to see, 44 px to hit (the segment's own hit area is 40).
          <ToggleGroupItem key={persona} value={persona} className="px-3 after:-inset-y-[5px]">
            {PERSONA_LABEL[persona]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {error ? (
        <p role="status" className="text-footnote text-blocked">
          {error}
        </p>
      ) : null}
    </>
  );
}
