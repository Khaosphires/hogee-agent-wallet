/** The message card's words (A7.20, A7.21; UX-PLAN D28). Hogee never sends the message: the founder copies it. */

export const ENQUIRY_TEXT = {
  title: "Your message, ready to send",
  subtitleOne: "For the supplier you picked. Read it, then send it yourself.",
  subtitleMany: (n: number): string => `For the ${n} suppliers you picked. Read it, then send it yourself.`,
  recipients: "Who it's for",
  never: "Hogee never sends messages for you.",
  paste: "Paste it into the seller's chat on their web page, or into an email.",
} as const;

/**
 * The tip with her own pick (the place on the list, never a name): "For example: I went with #1, 30% deposit, 70% on
 * delivery." With no known place, the tip names none.
 */
export function enquiryTip(ranks: readonly (number | null)[]): string {
  const rank = ranks.find((r): r is number => r !== null);
  const pick = rank === undefined ? "I went with them" : `I went with #${rank}`;
  return `When you agree on a price and how to pay, tell me. For example: "${pick}, 30% deposit, 70% on delivery."`;
}
