import * as React from "react";
import { Bot, CheckIcon, UserRound } from "lucide-react";
import { stepperItems, type StepState, type StepTone, type StepperStep } from "@/components/ui/stepper-steps";
import { cn } from "@/lib/utils";

type StepperProps = Omit<React.ComponentProps<"ol">, "children"> & {
  steps: readonly StepperStep[];
};

/** The 24 px marker: its fill says the state, its tone (when given) who acts. */
function markerClass(state: StepState, tone: StepTone | undefined): string {
  if (state === "done") return tone === "paid" ? "bg-paid text-ink-on" : "bg-ink text-ink-on";
  if (tone === "agent") return "bg-agent-wash text-agent shadow-[inset_0_0_0_1.5px_var(--agent)]";
  if (tone === "waiting") return "bg-waiting-wash text-waiting shadow-[inset_0_0_0_1.5px_var(--waiting)]";
  if (state === "current") return "bg-raised text-ink shadow-[inset_0_0_0_1.5px_var(--ink)]";
  return "bg-surface text-ink-3 shadow-[inset_0_0_0_1.5px_var(--line-2)]";
}

function Mark({ state, tone, number }: { state: StepState; tone: StepTone | undefined; number: number }) {
  if (state === "done") return <CheckIcon className="size-3.5" strokeWidth={2.5} />;
  if (tone === "agent") return <Bot className="size-3.5" />;
  if (tone === "waiting") return <UserRound className="size-3.5" />;
  return <>{number}</>;
}

/**
 * A compact horizontal progress stepper (the chat journey; the payment card's Signed → Cooling → Paid). Semantic <ol>;
 * the current step has aria-current="step", the others a visually hidden "completed" / "not started". Markers sit at
 * the start of each step with the connector running to the next one, filled once the step is done. On narrow screens
 * only the current step's label shows; the rest stay readable to screen readers.
 */
function Stepper({ steps, className, "aria-label": ariaLabel = "Progress", ...props }: StepperProps) {
  const items = stepperItems(steps);
  if (items.length === 0) return null;

  return (
    <ol data-slot="stepper" aria-label={ariaLabel} className={cn("grid w-full auto-cols-fr grid-flow-col gap-x-3", className)} {...props}>
      {items.map((item) => (
        <li
          key={item.key}
          data-slot="stepper-step"
          data-state={item.state}
          data-tone={item.tone}
          aria-current={item.ariaCurrent}
          className={cn(
            "relative grid min-w-0 content-start gap-1 pt-[30px]",
            // The connector to the next marker; filled (paid or ink) once this step is done.
            "after:absolute after:top-[11.5px] after:right-1.5 after:left-[30px] after:h-px after:bg-line-2 after:transition-[background-color] after:duration-(--dur-state) last:after:hidden",
            "data-[state=done]:after:bg-ink data-[state=done]:data-[tone=paid]:after:bg-paid",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute top-0 left-0 grid size-6 place-items-center rounded-full text-[0.6875rem] font-semibold tabular-nums transition-[background-color,color,box-shadow] duration-(--dur-state)",
              markerClass(item.state, item.tone),
            )}
          >
            <Mark state={item.state} tone={item.tone} number={item.number} />
          </span>
          <span
            className={cn(
              "truncate text-[0.8125rem] leading-tight",
              item.state === "current" ? "font-medium text-ink" : item.state === "done" ? "text-ink max-sm:sr-only" : "text-ink-2 max-sm:sr-only",
            )}
          >
            {item.label}
            {item.srState ? <span className="sr-only">, {item.srState}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export { Stepper };
export type { StepperProps };
export type { StepState, StepTone, StepperStep } from "@/components/ui/stepper-steps";
