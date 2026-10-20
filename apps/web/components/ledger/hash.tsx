"use client";

import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { useSession } from "@/lib/api/use-session";
import { txLinkOf } from "@/lib/explorer";
import { shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A tx link (DESIGN.md §2, §9): Geist Mono 12.5, ink, a line-2 underline that darkens on hover, a small arrow, and an
 * invisible `after:` margin that makes the hit area at least 40 px tall.
 */
const TX_LINK =
  "relative inline-flex items-center gap-1 rounded-sm font-mono text-[0.78125rem] tracking-[-0.01em] text-ink underline decoration-line-2 underline-offset-[3px] outline-none transition-[text-decoration-color] duration-(--dur-state) ease-settle hover:decoration-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-['']";

/**
 * A transaction hash. Links to the explorer pinned for its chain (lib/explorer.ts: Sepolia → Etherscan, Anvil →
 * none) only where txLinkOf allows: live, or a replay hash that an evidence bundle row records. Mock hashes and the
 * hashes the offline replay mints are placeholders: plain text (replay ones tagged "replay"), never a real explorer.
 * Pass `bundleChainId` only for a hash taken from an evidence bundle row (its row's own chain).
 */
export function TxHash({ hash, bundleChainId, className }: { hash: string; bundleChainId?: number; className?: string }) {
  const session = useSession().data;
  const link = txLinkOf(hash, { mode: session?.mode, sessionChainId: session?.chainId, bundleChainId });
  const text = <span>{shortHash(hash)}</span>;
  if (!link.href) {
    return (
      <span
        className={cn("inline-flex items-center gap-1 font-mono text-[0.78125rem] tracking-[-0.01em] text-ink-2", className)}
        title={`${hash} (${link.note})`}
        data-testid="tx-hash"
        data-linked="false"
      >
        {text}
        {link.tag ? <span className="font-sans text-[0.6875rem] tracking-[0.01em] text-ink-3">{link.tag}</span> : null}
      </span>
    );
  }
  return (
    <a href={link.href} target="_blank" rel="noreferrer" title={hash} data-testid="tx-hash" data-linked="true" className={cn(TX_LINK, className)}>
      {text}
      <ArrowUpRight aria-hidden className="size-3 shrink-0 text-ink-3" />
      <span className="sr-only">(opens the receipt on a public website, in a new tab)</span>
    </a>
  );
}

/**
 * A link to a page on a chain's pinned explorer (build `href` with lib/explorer.ts). With no href (a local chain, a
 * malformed value or mock data) the content is shown as plain text, never as a link.
 */
export function ExplorerLink({ href, title, children, className }: { href: string | null; title?: string; children: ReactNode; className?: string }) {
  if (!href) {
    return (
      <span className={cn("inline-flex items-center gap-1", className)} title={title}>
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      className={cn(
        "relative inline-flex items-center gap-1 rounded-sm text-ink underline decoration-line-2 underline-offset-[3px] outline-none transition-[text-decoration-color] duration-(--dur-state) hover:decoration-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-['']",
        className,
      )}
    >
      {children}
      <ArrowUpRight aria-hidden className="size-3 shrink-0 text-ink-3" />
      <span className="sr-only">(opens the receipt on a public website, in a new tab)</span>
    </a>
  );
}

/** Any other 32-byte value (digest, decision id, invoice hash): monospace, shortened, full value on hover. */
export function HexValue({ value, full = false, className }: { value: string; full?: boolean; className?: string }) {
  return (
    <span className={cn("font-mono text-[0.78125rem] tracking-[-0.01em] break-all", className)} title={value}>
      {full ? value : shortHash(value)}
    </span>
  );
}
