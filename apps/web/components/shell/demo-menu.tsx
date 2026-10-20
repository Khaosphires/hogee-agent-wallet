"use client";

/**
 * The old "Demo · Mei" button and its panel (UX-PLAN D12), now the quick settings (UX round 2): the shell and the menu
 * sheet still import these names, so they keep compiling and show the new quick settings until the shell switches to
 * components/settings/quick-settings.tsx. Same test ids, same persona switch, same data label.
 */
import { QuickSettings, QuickSettingsPanel } from "@/components/settings/quick-settings";

export function DemoPanel({ onDone, className }: { onDone?: () => void; className?: string }) {
  return <QuickSettingsPanel onDone={onDone} className={className} />;
}

export function DemoMenu({ className }: { className?: string }) {
  return <QuickSettings className={className} />;
}
