import { cn } from "@/lib/utils";
import { sealCode, sealCodeRows } from "./seal-code";

/**
 * The chop: the seal a signature leaves (DESIGN.md §4). A cinnabar square turned −4° with a white hairline inside its
 * edge. At 40 px it carries the seal code (the first four hex characters of the signing tx hash) 2 × 2 in Geist
 * Mono; at 20 px (rail, history) and 14 px (inline) it has none, so print the code beside it ("stamp C21E": on screen the mark is a stamp, UX-PLAN D20).
 *
 * It is decorative (`aria-hidden`): the words next to it say who signed. Cinnabar is used for nothing else.
 * The stamp animation lives in globals.css and plays only under an ancestor with `data-sealing="true"`.
 * `tone="ink"` is the brand mark (the logo is an ink chop, never cinnabar).
 */
export function Seal({
  txHash,
  size = 40,
  tone = "seal",
  letter,
  className,
}: {
  /** The signing transaction; without one (or a malformed one) the 40 px chop is blank. */
  txHash?: string | null;
  size?: 40 | 20 | 14;
  tone?: "seal" | "ink";
  /** The brand mark's letter, in place of a code. */
  letter?: string;
  className?: string;
}) {
  const code = size === 40 ? sealCode(txHash) : null;
  return (
    <span aria-hidden data-slot="seal" data-size={size === 40 ? undefined : String(size)} data-tone={tone === "ink" ? "ink" : undefined} className={cn("chop", className)}>
      {letter ? <span>{letter}</span> : code ? sealCodeRows(code).map((row) => <span key={row}>{row}</span>) : null}
    </span>
  );
}

/** "stamp C21E": the code printed beside a small chop, in Geist Mono. Nothing when there is no real hash. */
export function SealCode({ txHash, label = "stamp", className }: { txHash?: string | null; label?: string; className?: string }) {
  const code = sealCode(txHash);
  if (!code) return null;
  return (
    <span className={cn("whitespace-nowrap", className)}>
      {label} <span className="font-mono text-[0.78125rem] tracking-[-0.01em]">{code}</span>
    </span>
  );
}
