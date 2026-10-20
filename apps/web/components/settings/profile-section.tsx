"use client";

import type { CSSProperties } from "react";
import { Flag, Mail, Package, Phone, RotateCcw, Store, Truck, UserRound } from "lucide-react";
import { GroupedList } from "@/components/ui/grouped-list";
import { PageSection } from "@/components/ui/page-section";
import { COUNTRY_NAME, clearProfile, type Profile } from "@/lib/profile";
import { cn } from "@/lib/utils";
import { ColourRow, ProfileTextRow, ReadOnlyRow, SavedNote, useSaveStatus } from "./profile-fields";
import { AVATAR_FILL, ProfileAvatar } from "./profile-avatar";
import { ACTION_ROW } from "./settings-rows";
import { useFounderProfile } from "./use-founder-profile";

/** The banner: the avatar, the name, and who she is. It updates as the fields below are edited. */
function ProfileBanner({ profile, country }: { profile: Profile; country: keyof typeof COUNTRY_NAME }) {
  // A faint wash of her colour behind the banner, so the choice shows at once.
  const style = { "--avatar": AVATAR_FILL[profile.avatarColour] } as CSSProperties;
  return (
    <li
      style={style}
      className="flex items-center gap-4 bg-[color-mix(in_oklch,var(--avatar)_7%,var(--raised))] px-4 py-4 transition-[background-color] duration-(--dur-state) ease-settle"
    >
      <ProfileAvatar name={profile.displayName} colour={profile.avatarColour} size={64} />
      <div className="grid min-w-0 gap-0.5">
        <p data-testid="profile-name" className="truncate text-title-2 text-ink">
          {profile.displayName}
        </p>
        <p className="truncate text-footnote text-ink-3">
          Founder · {COUNTRY_NAME[country]}
          {profile.businessName ? ` · ${profile.businessName}` : ""}
        </p>
      </div>
    </li>
  );
}

export function ProfileSection() {
  const { profile, country } = useFounderProfile();
  const [status, report] = useSaveStatus();
  const common = { profile, country, onSaved: report };
  return (
    <PageSection id="settings-profile" title="Profile">
      <GroupedList>
        <ProfileBanner profile={profile} country={country} />
      </GroupedList>
      <GroupedList footer={<SavedNote status={status} />}>
        <ProfileTextRow field="displayName" label="Name" icon={UserRound} autoComplete="name" autoCapitalize="words" spellCheck={false} {...common} />
        <ColourRow {...common} />
        <ProfileTextRow field="email" label="Email" icon={Mail} type="email" inputMode="email" autoComplete="email" spellCheck={false} placeholder="name@example.com" {...common} />
        <ProfileTextRow field="phone" label="Phone" icon={Phone} type="tel" inputMode="tel" autoComplete="tel" placeholder={country === "SG" ? "+65" : "+60"} {...common} />
      </GroupedList>
    </PageSection>
  );
}

export function BusinessSection() {
  const { profile, country, stored } = useFounderProfile();
  const [status, report] = useSaveStatus();
  const common = { profile, country, onSaved: report };
  return (
    <PageSection id="settings-business" title="Business">
      <GroupedList
        footer={
          <SavedNote status={status}>
            <span className="block">It doesn&apos;t change your plan, who gets paid, or any limit.</span>
          </SavedNote>
        }
      >
        <ProfileTextRow field="businessName" label="Business name" icon={Store} autoComplete="organization" placeholder="Add a name" {...common} />
        <ProfileTextRow field="whatYouSell" label="What you sell" icon={Package} placeholder="Add what you sell" {...common} />
        <ProfileTextRow field="whereYouSell" label="Where you sell" icon={Truck} placeholder="Add where you sell" {...common} />
        <ReadOnlyRow icon={Flag} label="Country" value={COUNTRY_NAME[country]} note="set by your plan" />
      </GroupedList>
      {stored ? (
        <GroupedList>
          <li>
            <button type="button" onClick={() => clearProfile()} className={cn(ACTION_ROW, "justify-center text-ink-2 hover:text-ink")}>
              <RotateCcw aria-hidden className="size-4" />
              Go back to the demo details
            </button>
          </li>
        </GroupedList>
      ) : null}
    </PageSection>
  );
}
