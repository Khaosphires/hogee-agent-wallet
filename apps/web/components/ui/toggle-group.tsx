"use client";

import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { toggleVariants } from "@/components/ui/toggle";

/**
 * A segmented control (DESIGN.md §12): a 40 px ink-fill track (radius 12, 3 px inset), 34 px items, the active one a
 * white thumb (radius 9, concentric) on `shadow-sm`. Each item's hit area reaches the track's full 40 px. With
 * type="single" Radix renders a radiogroup of radios (the persona switch, the country switch, the timeline filter, a
 * period control). For equal segments with a sliding thumb, see <Segmented>.
 */
const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: "default",
  variant: "default",
});

function ToggleGroup({
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      className={cn("group/toggle-group flex w-fit max-w-full items-center gap-[3px] rounded-lg bg-fill-strong p-[3px]", className)}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext);

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      className={cn(
        toggleVariants({ variant: context.variant || variant, size: context.size || size }),
        "h-[34px] min-w-0 flex-1 shrink-0 rounded-[9px] bg-transparent px-3 text-[0.8125rem] shadow-none hover:bg-transparent focus:z-10 focus-visible:z-10",
        "after:absolute after:inset-x-0 after:-inset-y-[3px] after:content-['']",
        "data-[state=on]:bg-raised data-[state=on]:shadow-sm",
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
