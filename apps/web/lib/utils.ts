import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge taught the DESIGN.md theme names (app/globals.css @theme): without this it reads `text-ui` as a text
 * colour and drops it next to `text-ink`, and reads `shadow-card` as a shadow colour.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        ...["meta", "ui", "chat", "title", "page", "amount", "hero"],
        // The Apple type scale (DESIGN.md §12, ux2-design).
        ...["large-title", "title-1", "title-2", "title-3", "headline", "body", "callout", "subhead", "footnote", "caption", "caption-2"],
      ],
      shadow: ["card", "lift", "pop"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
