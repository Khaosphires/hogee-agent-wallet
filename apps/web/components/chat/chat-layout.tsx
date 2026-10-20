import type { ReactNode } from "react";

/**
 * The /chat page layout (DESIGN.md §6; ux2: the side nav takes 248 px on the left from 900 px, so the content column
 * is the viewport minus 248). From 1280 px: the thread column and the sticky 340 px wallet inspector. Bento (UX round
 * 3, the user's choice A): the thread widens with the window (760 px, 820 px from 1600 px; a reply's text keeps its own
 * 62ch measure, cards take the width), and from 1600 px the inspector becomes a two-column "at a glance" panel up to
 * 40 rem wide, so a 1920 screen has no empty sides. Under 1280 px the wallet is the sticky strip above the thread (the phone and tablet
 * pattern). The column is at least a screen tall (under the 56 px bar), so the composer (`mt-auto` in the thread)
 * sits at the bottom from the first message and never moves down as cards arrive (apple-design).
 */
export function ChatLayout({ head, strip, rail, children }: { head?: ReactNode; strip?: ReactNode; rail?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-[1280px]:grid-cols-[minmax(0,1fr)_340px] min-[1600px]:grid-cols-[minmax(0,1fr)_minmax(0,40rem)]">
      <div className="flex min-h-[calc(100dvh-3.5rem)] min-w-0 flex-col px-4 sm:px-6">
        {strip}
        <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-5 pt-5 sm:pt-7 min-[1600px]:max-w-[820px]">
          {head}
          {children}
        </div>
      </div>
      {rail}
    </div>
  );
}
