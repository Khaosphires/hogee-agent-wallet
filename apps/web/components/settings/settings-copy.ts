/**
 * Settings wording that depends on state (UX round 3), pure so it can be tested. Plain and neutral: nothing that is
 * simply "not here yet" should read as a fault.
 */

/**
 * Where the passkey is (friction review: "Not on this device" read as a fault). This browser keeps a passkey's public id
 * only when the passkey was made here (`suffix`, its last four characters); a plan already signed was signed with a
 * passkey on the device used to sign it; with neither, there is none yet, which is simply the start. `signer` is the
 * founder's first name when someone else (the loan officer) is looking.
 */
export function passkeyText(suffix: string | null, signed: boolean, signer?: string): string {
  if (suffix) return `On this device · ${suffix}`;
  if (signed) return signer ? `On ${signer}'s signing device` : "On your signing device";
  return "Not set up yet";
}

/** What the "Sample business" switch sees: the session's mode and whether it is the officer, and the mock's `available`. */
export interface SampleSwitchView {
  /** undefined until the session loads. */
  readonly mode: "mock" | "live" | "replay" | undefined;
  /** The verified persona is the loan officer (the session's persona, from the server's cookie check). */
  readonly officer: boolean;
  /** GET /api/demo/sample-business's `available`: undefined until it answers, false when it says no or failed. */
  readonly available: boolean | undefined;
}

export const SAMPLE_BUSINESS_HINT = "Mei three weeks in. Off: start fresh.";
export const SAMPLE_BUSINESS_OFFICER_ONLY = "Only the loan officer can switch the demo data. Use View as → Loan officer.";

/**
 * The switch works only for the loan officer in a mock demo that offers it (run-10 v-5, P1: the same rule as Reset the
 * demo; the server refuses anyone else with 403). The founder sees its state, locked.
 */
export function canSwitchSampleBusiness(v: SampleSwitchView): boolean {
  return v.mode === "mock" && v.available === true && v.officer;
}

/** The switch's one line: why it is off, who can switch it, or what it does. */
export function sampleBusinessNote(v: SampleSwitchView): string {
  if (v.mode === "live") return "Off in live mode: live money is never reset or made up.";
  if (v.mode === "replay") return "Off in the recorded demo: it plays its recording.";
  if (v.mode === "mock" && v.available === false) return "Not available in this demo.";
  if (v.mode === "mock" && !v.officer) return SAMPLE_BUSINESS_OFFICER_ONLY;
  return SAMPLE_BUSINESS_HINT;
}
