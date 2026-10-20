"use client";

import { useSyncExternalStore } from "react";
import { FileSignature, Fingerprint, ShieldCheck } from "lucide-react";
import type { PlanStatus } from "@hogee/core";
import { passkeyIdSuffix } from "@/components/sign/passkey-setup-card";
import { PROOF_HREF } from "@/components/shell/routes";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { PageSection } from "@/components/ui/page-section";
import { useApiQuery } from "@/lib/api/hooks";
import { PASSKEY_EVENT, storedCredentialId } from "@/lib/passkey";
import { firstNameOf } from "@/lib/profile";
import { passkeyText } from "./settings-copy";
import { SECURITY_TONE, SettingTile } from "./settings-rows";
import { useFounderProfile } from "./use-founder-profile";

/**
 * Security (UX round 2; UX round 3 wording): read only, from what the app already has. The passkey (the browser keeps
 * only its public id; the last four characters are what the loan officer's console shows too) and whether the current
 * plan is signed. Nothing here can add, remove or approve a passkey, or change what was signed.
 */

function subscribe(onChange: () => void): () => void {
  window.addEventListener(PASSKEY_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PASSKEY_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const useCredentialId = (): string | null => useSyncExternalStore(subscribe, () => storedCredentialId() ?? null, () => null);

const PLAN_STATE: Readonly<Record<PlanStatus, { readonly text: string; readonly signed: boolean }>> = {
  PENDING_SIGNATURE: { text: "Waiting for your signature", signed: false },
  SUBMITTED: { text: "Signed, being recorded", signed: true },
  COMMITTED: { text: "Signed", signed: true },
  SUPERSEDED: { text: "Replaced by a newer version", signed: true },
  REVERTED: { text: "Not recorded", signed: false },
};

function PlanValue({ status, pending }: { status: PlanStatus | undefined; pending: boolean }) {
  if (pending) return <span aria-hidden className="inline-block h-4 w-16 rounded-full bg-fill-strong align-middle" />;
  if (!status) return <>No plan yet</>;
  const state = PLAN_STATE[status];
  return (
    <span className="inline-flex items-center gap-2">
      {/* Cinnabar only for a completed signature (DESIGN.md §3). */}
      {state.signed ? <span aria-hidden data-size="14" className="chop" /> : null}
      {state.text}
    </span>
  );
}

export function SecuritySection() {
  const { officer, profile } = useFounderProfile();
  const credentialId = useCredentialId();
  // Read once (the same cache as every other plan read); this page doesn't need it live.
  const plan = useApiQuery("getCurrentPlan", undefined, { poll: false });
  const status = plan.data?.status;
  const signed = status !== undefined && PLAN_STATE[status].signed;
  const first = firstNameOf(profile.displayName);
  return (
    <PageSection id="settings-security" title="Security">
      <GroupedList footer={`Read only. A new passkey needs ${officer ? "the" : "your"} loan officer's approval.`}>
        <ListRow
          data-testid="security-passkey"
          leading={<SettingTile icon={Fingerprint} tone={SECURITY_TONE} />}
          title="Passkey"
          value={plan.isPending && !credentialId ? <span aria-hidden className="inline-block h-4 w-16 rounded-full bg-fill-strong align-middle" /> : passkeyText(credentialId ? passkeyIdSuffix(credentialId) : null, signed, officer ? first : undefined)}
        />
        <ListRow
          data-testid="security-plan"
          leading={<SettingTile icon={FileSignature} tone={SECURITY_TONE} />}
          title={officer ? `${first}'s plan` : "Your plan"}
          value={<PlanValue status={status} pending={plan.isPending} />}
        />
      </GroupedList>
      <GroupedList>
        {/* The founder lands on the Plan's safety limit (friction log #35: not the tax rules); the officer on Proof. */}
        <ListRow href={officer ? PROOF_HREF : "/plan#plan-safety"} leading={<SettingTile icon={ShieldCheck} tone={SECURITY_TONE} />} title="How Hogee keeps your money safe" />
      </GroupedList>
    </PageSection>
  );
}
