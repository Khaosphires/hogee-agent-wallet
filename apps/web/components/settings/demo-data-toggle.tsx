"use client";

/**
 * The "Sample business" switch (P1, UX round 2; docs/decisions/ux2-demo-data.md). ON: the mock serves Mei about three
 * weeks in (MOCK_SCENARIO=lived, the dev:mock default); OFF: a fresh start (the chat journey from the first question).
 * Mock mode only: it reads and flips the mock-only GET/POST /api/demo/sample-business (packages/api-mock demo-data.ts),
 * which the live API does not have; in live mode the switch is disabled and says so, and in the recorded demo too.
 * The loan officer's only, as Reset the demo (run-10 v-5, P1): the server refuses anyone else (403), and the founder
 * sees the state, locked, with one line saying how to switch (settings-copy.ts sampleBusinessNote).
 *
 * Switching rebuilds the demo, so when the demo was used since it was built (the mock's `used`) it asks first. After a
 * switch the officer lands on their home page with every query fetched again: a new chat session for Mei, the "Goods
 * arrived" marks of the old orders dropped, the in-flight queries cancelled, then a full navigation, so nothing from the
 * old demo (the query cache, a mounted thread, in-memory marks) survives. It is a whole row of a GroupedList (UX round
 * 3: ui/grouped-list's ListRow, a neutral tile, ui/switch), placed in the quick settings and on the Settings page.
 */
import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ListRow } from "@/components/ui/grouped-list";
import { homeFor } from "@/components/shell/routes";
import { Switch } from "@/components/ui/switch";
import { useSession } from "@/lib/api/use-session";
import { resetChatSessionId } from "@/lib/chat-session";
import { canSwitchSampleBusiness, sampleBusinessNote } from "./settings-copy";
import { SettingTile } from "./settings-rows";

const PATH = "/api/demo/sample-business";
/** lib/order-phase.ts keeps a per-order "Goods arrived" mark under this prefix; the sample's orders reuse their ids. */
const GOODS_ARRIVED_PREFIX = "hogee.goodsArrived.";

const DemoDataState = z.strictObject({
  available: z.boolean(),
  on: z.boolean(),
  scenario: z.enum(["default", "fresh", "lived"]).nullable(),
  used: z.boolean(),
});
type DemoDataState = z.infer<typeof DemoDataState>;

export const demoDataKey = ["demoSampleBusiness"] as const;

/** The switch's state, parsed strictly: anything else is an error (the switch is then off-limits, never guessed). */
async function readState(signal?: AbortSignal): Promise<DemoDataState> {
  const res = await fetch(PATH, { credentials: "same-origin", cache: "no-store", signal });
  if (!res.ok) throw new Error(`The demo data switch is not available here (${res.status})`);
  return DemoDataState.parse(await res.json());
}

async function flip(on: boolean): Promise<void> {
  const res = await fetch(PATH, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) });
  if (res.ok) return;
  const body: unknown = await res.json().catch(() => null);
  const message = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
  throw new Error(message.success ? message.data.error.message : `The demo could not be switched (${res.status})`);
}

function dropGoodsArrivedMarks(): void {
  try {
    const keys = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)).filter((k): k is string => k?.startsWith(GOODS_ARRIVED_PREFIX) === true);
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    // Storage blocked: the marks lived in this page only, and the navigation below drops them.
  }
}

export function DemoDataToggle({ className }: { className?: string }) {
  const labelId = useId();
  const hintId = useId();
  const session = useSession().data;
  const queryClient = useQueryClient();
  const mock = session?.mode === "mock";
  const state = useQuery({ queryKey: demoDataKey, queryFn: ({ signal }) => readState(signal), enabled: mock, staleTime: 0, retry: false });
  const [confirmOn, setConfirmOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const on = state.data?.on ?? false;
  const view = { mode: session?.mode, officer: session?.persona === "officer", available: state.isError ? false : state.data?.available };
  const canSwitch = canSwitchSampleBusiness(view);
  const note = sampleBusinessNote(view);

  async function apply(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      await flip(next);
      dropGoodsArrivedMarks();
      resetChatSessionId();
      // A full navigation: every query is fetched again from the rebuilt demo, and no old state stays mounted.
      await queryClient.cancelQueries();
      // A document load on purpose (as "Clear this chat" reloads): router.push keeps the old demo's in-memory state.
      // Home is the officer's page (only the officer switches; /chat is Mei's).
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(session ? homeFor(session.persona) : "/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The demo could not be switched");
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: demoDataKey });
    }
  }

  async function toggle() {
    if (!canSwitch || busy) return;
    const next = !on;
    // Read `used` fresh: the demo may have been used since this panel opened.
    const fresh = await state.refetch();
    if (fresh.data?.used) setConfirmOn(next);
    else void apply(next);
  }

  return (
    <ListRow
      data-testid="demo-data-toggle"
      data-on={on ? "true" : "false"}
      className={className}
      leading={<SettingTile icon={Briefcase} />}
      title={<span id={labelId}>Sample business</span>}
      subtitle={
        <>
          <span id={hintId} className="block">
            {note}
          </span>
          {error ? (
            <span role="alert" className="block text-blocked">
              {error}
            </span>
          ) : null}
        </>
      }
      trailing={
        <>
          <Switch
            data-testid="demo-data-switch"
            checked={on}
            disabled={!canSwitch || busy || (state.isFetching && !state.data)}
            aria-labelledby={labelId}
            aria-describedby={hintId}
            onCheckedChange={() => void toggle()}
          />
          <Dialog open={confirmOn !== null} onOpenChange={(open) => (open ? undefined : setConfirmOn(null))}>
            <DialogContent className="sm:max-w-md" data-testid="demo-data-confirm">
              <DialogHeader>
                <DialogTitle>{confirmOn ? "Show the sample business?" : "Start fresh?"}</DialogTitle>
                <DialogDescription>
                  {confirmOn
                    ? "This replaces what you did in this demo with Mei's sample business, three weeks in. Nothing real changes."
                    : "This clears the sample business and what you did in this demo, so Mei starts from the first question. Nothing real changes."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmOn(null)} disabled={busy}>
                  Keep this demo
                </Button>
                <Button onClick={() => confirmOn !== null && void apply(confirmOn)} disabled={busy}>
                  {confirmOn ? "Show the sample" : "Start fresh"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      }
    />
  );
}
