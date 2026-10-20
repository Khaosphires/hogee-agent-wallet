import type { CSSProperties } from "react";
import { initialsOf, type AvatarColour } from "@/lib/profile";
import { cn } from "@/lib/utils";

/**
 * Avatar fills: each a darker cut of a chart hue so white initials pass 4.5:1 at every size (large text needs 3:1).
 * No cinnabar (the signature's colour) and no green (money in).
 */
export const AVATAR_FILL: Readonly<Record<AvatarColour, string>> = {
  teal: "oklch(0.5 0.095 195)",
  blue: "oklch(0.5 0.13 250)",
  violet: "oklch(0.49 0.15 292)",
  rose: "oklch(0.52 0.16 355)",
  graphite: "oklch(0.42 0.022 260)",
};

export const AVATAR_COLOUR_NAME: Readonly<Record<AvatarColour, string>> = {
  teal: "Teal",
  blue: "Blue",
  violet: "Violet",
  rose: "Rose",
  graphite: "Graphite",
};

/**
 * The founder's initials on her colour. The letters are drawn by CSS (`content: attr(data-initials)`), so they never
 * join a button's text or accessible name: the avatar is decoration, and the name sits next to it. `size` is the
 * diameter in px at the default text size.
 */
export function ProfileAvatar({ name, colour, size = 32, className }: { name: string; colour: AvatarColour; size?: number; className?: string }) {
  // rem, so the circle grows with the letters when the browser's text size is larger.
  const rem = (px: number) => `${px / 16}rem`;
  const style = { "--avatar": AVATAR_FILL[colour], width: rem(size), height: rem(size), fontSize: rem(size * 0.4) } as CSSProperties;
  return (
    <span
      aria-hidden
      data-initials={initialsOf(name) || "?"}
      style={style}
      className={cn(
        "relative inline-grid shrink-0 place-items-center rounded-full bg-(--avatar) leading-none font-semibold tracking-[0.01em] text-ink-on select-none",
        "shadow-[inset_0_1px_0_oklch(1_0_0/0.22),inset_0_0_0_0.5px_oklch(0_0_0/0.12)]",
        "transition-[background-color] duration-(--dur-state) ease-settle",
        "before:content-[attr(data-initials)]",
        className,
      )}
    />
  );
}
