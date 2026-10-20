"use client";

import { useId, useState } from "react";
import { Database, RotateCcw, UsersRound } from "lucide-react";
import { errorCopy } from "@hogee/core";
import { DemoDataToggle } from "@/components/settings/demo-data-toggle";
import { ModeBadge } from "@/components/shell/mode-badge";
import { PersonaRadios } from "@/components/shell/persona-switch";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { PageSection } from "@/components/ui/page-section";
import { useApiMutation } from "@/lib/api/hooks";
import { useRecording } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import { RecordingNote, RecordingRow, useHydrated } from "./recording-row";
import { ACTION_ROW, SettingRow, SettingTile } from "./settings-rows";
import { useFounderProfile } from "./use-founder-profile";

/** "View as": the shell's persona radios (same server check, same officer access-code dialog), as a settings row. */
export function ViewAsRow({ onChose }: { onChose?: () => void }) {
  const labelId = useId();
  return (
    <SettingRow icon={UsersRound} columnClassName="gap-1 pb-3">
      <span id={labelId} className="flex min-h-11 items-center text-callout text-ink">
        View as
      </span>
      <div role="group" aria-labelledby={labelId} className="grid w-full grid-cols-1 gap-1.5">
        <PersonaRadios onChose={onChose} />
      </div>
    </SettingRow>
  );
}

/** What the numbers on screen are: the data label (one word, "Sample", in a demo), as a row. */
export function DataLabelRow() {
  return <ListRow leading={<SettingTile icon={Database} />} title="This demo shows" trailing={<ModeBadge />} />;
}

/** The "Sample business" switch (components/settings/demo-data-toggle.tsx): it is a whole row of its own. */
export function SampleBusinessRow() {
  return <DemoDataToggle />;
}

/**
 * "Reset the demo" for the loan officer only: the officer console's Demo tools reset (POST /api/demo/reset, demo mode
 * only, the server checks the officer persona), behind a confirmation. Hidden while recording, like every demo tool.
 */
function ResetDemo() {
  const reset = useApiMutation("demoReset");
  const [open, setOpen] = useState(false);
  const failed = reset.error ? (reset.error.code === "NOT_FOUND" ? "Demo buttons are off in this version." : errorCopy(reset.error.code).title) : undefined;
  return (
    <GroupedList
      footer={
        reset.isSuccess ? (
          <span role="status">The demo is back to how it started.</span>
        ) : failed ? (
          <span role="alert" className="text-blocked">
            {failed}
          </span>
        ) : (
          "Everything goes back to how this demo started, for everyone using it."
        )
      }
    >
      <li>
        <button type="button" onClick={() => setOpen(true)} disabled={reset.isPending} className={cn(ACTION_ROW, "text-blocked hover:bg-blocked-wash")}>
          <RotateCcw aria-hidden className="size-4" />
          Reset the demo
        </button>
      </li>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset the demo?</DialogTitle>
            <DialogDescription>Chats, payments and orders go back to how this demo started, for everyone using it.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setOpen(false);
                reset.mutate(undefined);
              }}
            >
              Reset the demo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </GroupedList>
  );
}

export function DemoSection() {
  const { officer } = useFounderProfile();
  const recording = useRecording();
  const hydrated = useHydrated();
  return (
    <PageSection id="settings-demo" title="Demo">
      <GroupedList>
        <DataLabelRow />
        <ViewAsRow />
      </GroupedList>
      <GroupedList footer={recording && hydrated ? <RecordingNote /> : "The Sample labels always show."}>
        <SampleBusinessRow />
        <RecordingRow />
      </GroupedList>
      {officer && hydrated && !recording ? <ResetDemo /> : null}
    </PageSection>
  );
}
