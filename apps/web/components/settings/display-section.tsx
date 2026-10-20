import { PageSection } from "@/components/ui/page-section";

/**
 * Display (UX round 3): one line, no rows. Hogee follows the device's own settings for text size, motion and
 * transparency (DESIGN.md §11), and there is nothing to switch here, so nothing here looks like it could be pressed
 * (friction log #38).
 */
export function DisplaySection() {
  return <PageSection id="settings-display" title="Display" line="Text size, motion and transparency follow your device settings.">{null}</PageSection>;
}
