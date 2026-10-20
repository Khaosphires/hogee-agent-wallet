/**
 * Props every chat-first card takes (VISION-DECISIONS §4, §7). A card reads live state over REST by the ids in its
 * data part (lib/api/queries.ts) and answers through `act`: a structured ChatAction (no free text) plus the label the
 * founder's bubble shows. `answered` is true once a later message exists, so stale buttons can be disabled.
 */
import type { ChatAction, ChatDataPartType } from "@hogee/core";

export interface CardProps<D> {
  readonly data: D;
  readonly answered: boolean;
  readonly act: (a: ChatAction, label: string) => void;
}

/** The data-testid of a part's card: "card-" + the part name (data-needs → card-needs). */
export const cardTestId = (type: ChatDataPartType): string => `card-${type.slice("data-".length)}`;
