import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A well (10 px radius, no border): `default` is a sunk note, `destructive` the error state (blocked wash; the title
 * says what didn't happen, the description says "Nothing was paid or changed" when true, then the way out), and
 * `agent` an agent note (agent wash) for what the wallet did on its own.
 */
const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg px-3.5 py-3 text-[0.8125rem] leading-[1.1875rem] has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-2.5 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-sunk text-ink [&>svg]:text-ink-2",
        destructive: "bg-blocked-wash text-blocked *:data-[slot=alert-description]:text-ink-2",
        agent: "bg-agent-wash text-agent *:data-[slot=alert-description]:text-ink-2",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("col-start-2 min-h-4 font-semibold text-pretty", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("col-start-2 grid justify-items-start gap-1 text-[0.8125rem] text-ink-2 [&_p]:leading-[1.1875rem]", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
