"use client";

import { useState, type ComponentProps } from "react";
import { ChevronDown, Landmark, Settings, ShieldCheck } from "lucide-react";
import { Popover } from "radix-ui";
import { ModeBadge } from "@/components/shell/mode-badge";
import { PROOF_HREF } from "@/components/shell/routes";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/api/use-session";
import { PERSONA_NAME } from "@/lib/persona";
import { COUNTRY_NAME, firstNameOf } from "@/lib/profile";
import { useRecording } from "@/lib/presentation";
import { cn } from "@/lib/utils";
import { SampleBusinessRow, ViewAsRow } from "./demo-section";
import { ProfileAvatar } from "./profile-avatar";
import { RecordingNote, RecordingRow, useHydrated } from "./recording-row";
import { SECURITY_TONE, SettingTile } from "./settings-rows";
import { useFounderProfile } from "./use-founder-profile";

/**
 * The top-right quick settings (UX round 2, P1 decision 3): one button that holds every toggle, in an iOS grouped
 * popover that grows from it. View as (the shell's persona radios: same server check, same officer access-code
 * dialog), Sample business, Recording mode, For reviewers: Proof, and All settings. Built from the shared GroupedList,
 * ListRow, IconTile and Switch, with the neutral settings tiles (UX round 3). It replaces the "Demo · Mei" button
 * and keeps its test ids (`demo-menu` with data-persona/data-mode, `demo-menu-panel`, `demo-menu-proof`,
 * `recording-note`) and the data label (`mode-badge`), which other suites and the demo recorder use.
 */

/** The loan officer's tile where the founder's avatar would be (the profile on this device is the founder's). */
function OfficerTile({ size }: { size: number }) {
  const rem = (px: number) => `${px / 16}rem`;
  return (
    <span aria-hidden style={{ width: rem(size), height: rem(size) }} className="grid shrink-0 place-items-center rounded-full bg-ink-2 text-ink-on shadow-[inset_0_1px_0_oklch(1_0_0/0.2)]">
      <Landmark style={{ width: rem(size * 0.5), height: rem(size * 0.5) }} strokeWidth={2} />
    </span>
  );
}

/** Who is viewing: the avatar and name, what they are, and the data label (Sample data / Sepolia test network). */
function WhoRow() {
  const { profile, country, officer } = useFounderProfile();
  return (
    <div className="flex items-center gap-3 px-2 pt-1 pb-0.5">
      {officer ? <OfficerTile size={40} /> : <ProfileAvatar name={profile.displayName} colour={profile.avatarColour} size={40} />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-headline text-ink">{officer ? PERSONA_NAME.officer : profile.displayName}</p>
        <p className="truncate text-footnote text-ink-3">{officer ? "Approves and funds" : `Founder · ${COUNTRY_NAME[country]}`}</p>
      </div>
      <ModeBadge />
    </div>
  );
}

/**
 * The quick settings' body, in the top-right popover and anywhere else that wants it (QuickSettingsPanel). `onDone`
 * closes the surface holding it once a choice is made, so the officer's access-code dialog opens on its own.
 */
function QuickSettingsBody({ onDone, className }: { onDone?: () => void; className?: string }) {
  const recording = useRecording();
  const hydrated = useHydrated();
  return (
    <div className={cn("grid grid-cols-1 gap-3", className)}>
      <WhoRow />
      <GroupedList>
        <ViewAsRow onChose={onDone} />
      </GroupedList>
      <GroupedList footer={recording && hydrated ? <RecordingNote testId /> : undefined}>
        <SampleBusinessRow />
        <RecordingRow />
      </GroupedList>
      {/* ListRow's link closes the popover through the list's own click (the link has no onClick of its own). */}
      <GroupedList onClickCapture={(e) => (e.target instanceof Element && e.target.closest("a") ? onDone?.() : undefined)}>
        <ListRow href={PROOF_HREF} leading={<SettingTile icon={ShieldCheck} tone={SECURITY_TONE} />} title="For reviewers: Proof" data-testid="demo-menu-proof" />
        <ListRow href="/settings" leading={<SettingTile icon={Settings} />} title="All settings" data-testid="quick-settings-all" />
      </GroupedList>
    </div>
  );
}

/** The trigger: the founder's avatar and first name (the loan officer's tile and title), and a chevron. */
function Trigger({ className, ...props }: { className?: string } & ComponentProps<"button">) {
  const { data: session } = useSession();
  const { profile, officer } = useFounderProfile();
  if (!session) return null;
  const name = officer ? PERSONA_NAME.officer : firstNameOf(profile.displayName) || PERSONA_NAME[session.persona];
  return (
    <button
      type="button"
      data-testid="demo-menu"
      data-persona={session.persona}
      data-mode={session.mode}
      className={cn(
        "group/quick relative inline-flex h-9 max-w-[12.5rem] items-center gap-2 rounded-full pr-2.5 pl-1 text-[0.8125rem] font-medium text-ink outline-none select-none",
        "shadow-[inset_0_0_0_1px_var(--line-2)] transition-[background-color,scale] duration-(--dur-state) ease-settle hover:bg-sunk",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-(--press) active:bg-sunk-2 active:duration-(--dur-press) data-[state=open]:bg-sunk",
        "motion-reduce:active:opacity-80",
        // 36 px to see, 44 px to hit.
        "after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']",
        className,
      )}
      {...props}
    >
      <span className="relative">
        {officer ? <OfficerTile size={28} /> : <ProfileAvatar name={profile.displayName} colour={profile.avatarColour} size={28} />}
        {session.mode === "live" ? (
          <span aria-hidden className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-paid shadow-[0_0_0_2px_var(--canvas)]" />
        ) : null}
      </span>
      <span className="sr-only">Quick settings: </span>
      <span className="truncate">{name}</span>
      <ChevronDown aria-hidden className="size-3.5 shrink-0 text-ink-3 transition-[rotate] duration-(--dur-state) ease-settle group-data-[state=open]/quick:rotate-180" />
    </button>
  );
}

const POPOVER = cn(
  "z-50 w-[21rem] max-w-[calc(100vw-1rem)] rounded-[22px] bg-canvas p-2 shadow-pop outline-none",
  // Grows out of the button (Radix's transform origin is the trigger's corner) and goes back into it.
  "pop-surface origin-(--radix-popover-content-transform-origin)",
  "max-h-[calc(var(--radix-popover-content-available-height)-0.5rem)] overflow-y-auto overscroll-contain",
);

export function QuickSettings({ className }: { className?: string }) {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);

  if (!session) return <Skeleton aria-hidden className={cn("h-9 w-24 rounded-full", className)} />;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Trigger className={className} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={8} aria-label="Quick settings" data-testid="demo-menu-panel" className={POPOVER}>
          <QuickSettingsBody onDone={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The same body without the trigger (a phone drawer or sheet can hold it). */
export function QuickSettingsPanel({ onDone, className }: { onDone?: () => void; className?: string }) {
  return <QuickSettingsBody onDone={onDone} className={className} />;
}
