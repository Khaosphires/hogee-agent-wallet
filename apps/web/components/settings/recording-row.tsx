"use client";

import { useId, useSyncExternalStore } from "react";
import { Video } from "lucide-react";
import { ListRow } from "@/components/ui/grouped-list";
import { Switch } from "@/components/ui/switch";
import { setRecording, useRecording } from "@/lib/presentation";
import { SettingTile } from "./settings-rows";

/**
 * Recording mode as a switch (lib/presentation.ts setRecording): on, it hides the demo and developer tools for a screen
 * recording; it never hides the Sample labels and never enables anything. The label is the switch's accessible name;
 * the line under it says what it does (friction log #37), since switching it changes nothing else on the page.
 */
export function RecordingRow() {
  const recording = useRecording();
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <ListRow
      leading={<SettingTile icon={Video} />}
      title={
        <label htmlFor={id} className="cursor-pointer">
          Recording mode
        </label>
      }
      subtitle={<span id={hintId}>Hides demo switches for a screen recording.</span>}
      trailing={<Switch id={id} aria-describedby={hintId} checked={recording} onCheckedChange={setRecording} />}
    />
  );
}

const never = () => () => undefined;
/** False during the server render and hydration, true after: recording mode reads "on" until the browser knows. */
export const useHydrated = (): boolean => useSyncExternalStore(never, () => true, () => false);

/** Under the switch while it is on. `testId` only in the quick settings (other suites read it there; ids stay unique). */
export function RecordingNote({ testId = false }: { testId?: boolean }) {
  const recording = useRecording();
  const hydrated = useHydrated();
  if (!recording || !hydrated) return null;
  return (
    <span className="enter-fade block" data-testid={testId ? "recording-note" : undefined}>
      Recording mode: demo tools are hidden.
    </span>
  );
}
