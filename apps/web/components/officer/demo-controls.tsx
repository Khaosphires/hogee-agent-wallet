"use client";

import { useState, type FormEvent } from "react";
import { errorCopy } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApiMutation } from "@/lib/api/hooks";
import type { ApiClientError } from "@/lib/api/client";
import { parseBuInput } from "@/lib/format";

function failure(...errors: (ApiClientError | null)[]): string | undefined {
  const e = errors.find(Boolean);
  if (!e) return undefined;
  return e.code === "NOT_FOUND" ? "Demo buttons are off in this version." : `${errorCopy(e.code).title}: ${e.message}`;
}

/**
 * Demo-only controls (/api/demo/*, 404 unless DEMO_MODE=1) for the scripted demo and the video. The officer console
 * folds them under "Demo tools" at the bottom and hides them while recording (UX-PLAN D10, D14). None can loosen the plan.
 */
export function DemoControls() {
  const start = useApiMutation("demoAutonomyStart");
  const stop = useApiMutation("demoAutonomyStop");
  const sale = useApiMutation("demoSale");
  const crash = useApiMutation("demoCrashNextBroadcast");
  const reset = useApiMutation("demoReset");
  const [amount, setAmount] = useState("");
  const amountMinor = parseBuInput(amount);
  const running = stop.isSuccess ? false : start.isSuccess ? true : undefined;
  const error = failure(start.error, stop.error, sale.error, crash.error, reset.error);

  function recordSale(e: FormEvent) {
    e.preventDefault();
    if (amountMinor) sale.mutate({ body: { amountMinor } });
  }

  return (
    <div data-testid="demo-controls" className="grid gap-4">
      <p className="text-[0.8125rem] text-pretty text-ink-2">For the demo only. These buttons run the demo story. None of them can loosen the plan.</p>
      <div className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={start.isPending || running === true} onClick={() => start.mutate(undefined)}>
            Start the AI
          </Button>
          <Button variant="secondary" size="sm" disabled={stop.isPending || running !== true} onClick={() => stop.mutate(undefined)}>
            Stop the AI
          </Button>
          <Button variant="secondary" size="sm" disabled={crash.isPending} onClick={() => crash.mutate(undefined)}>
            Crash Hogee during the next payment (test)
          </Button>
          <Button variant="ghost" size="sm" disabled={reset.isPending} onClick={() => reset.mutate(undefined)}>
            Reset the demo
          </Button>
        </div>
        {running !== undefined ? <p className="text-[0.8125rem] text-ink-2" role="status">The AI is {running ? "running" : "stopped"}.</p> : null}
        {crash.isSuccess ? <p className="text-[0.8125rem] text-ink-2" role="status">Ready: Hogee&apos;s sender will crash right after it sends the next payment.</p> : null}
        <form onSubmit={recordSale} className="flex flex-wrap items-end gap-2 border-t border-line pt-4" aria-label="Record a test sale">
          <div className="grid gap-1.5">
            <Label htmlFor="sale-amount">Test sale (BU)</Label>
            <Input id="sale-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32" />
          </div>
          <Button type="submit" variant="secondary" disabled={!amountMinor || sale.isPending}>
            Record a sale
          </Button>
          {sale.data ? <span className="text-[0.8125rem] text-ink-2">Recorded ({sale.data.paymentIntentId}). The share kept for tax shows in the Wallet.</span> : null}
        </form>
        {error ? <p className="text-[0.8125rem] text-blocked" role="alert">{error}</p> : null}
      </div>
    </div>
  );
}
