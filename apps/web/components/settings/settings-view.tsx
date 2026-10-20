"use client";

import { PageHead } from "@/components/ui/page-section";
import { DemoSection } from "./demo-section";
import { DisplaySection } from "./display-section";
import { BusinessSection, ProfileSection } from "./profile-section";
import { SecuritySection } from "./security-section";

/**
 * The Settings page (UX round 2; UX round 3: the shared PageHead, PageSection, GroupedList and tiles, laid out as bento).
 * iOS Settings on the canvas: one large title, then one PageSection per id in lib/sections.ts for "/settings" (the side
 * nav lists and scrolls to them): Profile, Business, Display, Demo, Security. The page is a `bento` container on the
 * shell's frame (same left edge as every page); the groups flow into balanced columns (`bento-columns`, app/bento.css:
 * one on a phone, two from a 56 rem content width, three from 68 rem), read top to bottom, then left to right, in the
 * side nav's order, so the whole page fits on one screen at 1440. Profile and business details stay on this device;
 * nothing here changes what was signed, who gets paid, or any limit.
 */
export function SettingsView() {
  return (
    <div className="bento grid w-full min-w-0 grid-cols-1 gap-7 pb-6">
      <PageHead title="Settings" />
      <div className="bento-columns">
        <ProfileSection />
        <BusinessSection />
        <DisplaySection />
        <DemoSection />
        <SecuritySection />
      </div>
    </div>
  );
}
