/**
 * What <Stepper> renders for each step, kept free of React so it can be unit-tested. The current step carries
 * aria-current="step" (screen readers say "current step"); done and upcoming steps carry a visually hidden state.
 * Only one element in a set may be current, so a second "current" step keeps its look but not the attribute.
 */

export const STEP_STATES = ["done", "current", "upcoming"] as const;
export type StepState = (typeof STEP_STATES)[number];

/**
 * What a step's marker says beyond its state (DESIGN.md §7, the payment card): "paid" (money landed, green check),
 * "agent" (the wallet acts alone, cobalt), "waiting" (only Mei can act). Without one the marker is ink.
 */
export const STEP_TONES = ["paid", "agent", "waiting"] as const;
export type StepTone = (typeof STEP_TONES)[number];

export interface StepperStep {
  label: string;
  state: StepState;
  tone?: StepTone;
}

export interface StepperItem extends StepperStep {
  /** 1-based position, shown in the marker. */
  number: number;
  ariaCurrent: "step" | undefined;
  /** Visually hidden text read after the label; empty for the current step. */
  srState: string;
  key: string;
}

const SR_STATE: Record<StepState, string> = { done: "completed", current: "", upcoming: "not started" };

export function stepperItems(steps: readonly StepperStep[]): StepperItem[] {
  const firstCurrent = steps.findIndex((s) => s.state === "current");
  return steps.map((step, i) => ({
    label: step.label,
    state: step.state,
    number: i + 1,
    ariaCurrent: i === firstCurrent ? "step" : undefined,
    srState: SR_STATE[step.state],
    key: `${i}-${step.label}`,
    ...(step.tone ? { tone: step.tone } : {}),
  }));
}
