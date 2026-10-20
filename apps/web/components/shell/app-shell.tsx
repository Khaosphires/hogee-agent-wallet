import type { ReactNode } from "react";
import { QuickSettings } from "@/components/settings/quick-settings";
import { BrandLink } from "./brand-link";
import { NavDrawer } from "./nav-drawer";
import { PersonaSwitchProvider } from "./persona-switch";
import { SectionNavProvider } from "./section-nav";
import { ShellFrame } from "./shell-frame";
import { Sidebar } from "./sidebar";
import { SkipLink } from "./skip-link";
import { TopBar } from "./top-bar";

/**
 * The shell (DESIGN.md §5; side nav since UX round 2). From 900 px: a fixed 248 px sidebar on the left (brand, the
 * persona's pages with their section drop-downs, Settings at the foot) and, over the content column beside it, the
 * 56 px sticky top bar in the translucent material with the quick settings at the top right. Under 900 px: no
 * sidebar; the bar holds the drawer button, the brand and the quick settings, and the side nav opens as a drawer from
 * the left. The window scrolls (no inner scroller), so sticky things under the bar still use top-14. One persona-switch
 * provider serves the whole shell (one officer access-code dialog); one section-nav provider runs the scroll-spy and
 * the section jumps for the sidebar and the drawer alike.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <PersonaSwitchProvider>
      <SectionNavProvider>
        <SkipLink />
        <Sidebar className="hidden min-[900px]:flex" />
        <div className="flex min-h-dvh min-w-0 flex-col min-[900px]:pl-62">
          <TopBar>
            <div className="flex h-14 items-center gap-1.5 pr-3 pl-2 sm:pr-4 min-[900px]:pl-5">
              <NavDrawer className="min-[900px]:hidden" />
              <BrandLink className="min-[900px]:hidden" />
              <div className="ml-auto flex items-center gap-2.5">
                <QuickSettings />
              </div>
            </div>
          </TopBar>
          <ShellFrame>{children}</ShellFrame>
        </div>
      </SectionNavProvider>
    </PersonaSwitchProvider>
  );
}
