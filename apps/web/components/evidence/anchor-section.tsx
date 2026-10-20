"use client";

import { ChevronRight } from "lucide-react";
import type { BundleAnchor } from "@hogee/verify-evidence";
import { ExplorerLink } from "@/components/ledger/hash";
import { useLinksToExplorer } from "@/lib/api/queries";
import { addressUrl, blockUrl, chainLabel, explorerOf, txUrl } from "@/lib/explorer";
import { shortHash } from "@/lib/format";

/**
 * The bundle's anchor (G0-DECISIONS §14 "Anchor and online mode"): what a judge compares with the chain, because an
 * offline check has no trust root of its own. Links come only from the explorer pinned for the anchor's chain
 * (lib/explorer.ts), and only in live and replay mode.
 */
export function AnchorSection({ anchor, verified }: { anchor: BundleAnchor | null; verified: boolean }) {
  const linkable = useLinksToExplorer();
  if (!anchor) {
    return (
      <section aria-labelledby="anchor-heading" data-testid="verify-anchor" data-state="none" className="grid gap-1 rounded-group bg-raised p-4 shadow-card">
        <h3 id="anchor-heading" className="text-[0.8125rem] font-semibold text-ink">
          Blockchain link
        </h3>
        <p className="text-meta text-pretty text-ink-2">None: the files didn&apos;t load, so there&apos;s nothing to compare.</p>
      </section>
    );
  }
  const chain = linkable ? anchor.chainId : null;
  const explorer = explorerOf(chain);
  return (
    <section aria-labelledby="anchor-heading" data-testid="verify-anchor" data-state={explorer ? "explorer" : "local"} className="grid gap-3 rounded-group bg-raised p-4 shadow-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id="anchor-heading" className="text-[0.8125rem] font-semibold text-ink">
          Blockchain link
        </h3>
        <span className="text-meta text-ink-3">{explorer ? `Compare on ${new URL(explorer).hostname}` : linkable ? "No public explorer for this chain" : "Sample data: not linked"}</span>
      </div>
      {!verified ? <p className="text-meta text-pretty text-blocked">Shown for reference only: a check above failed, so these values prove nothing yet.</p> : null}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 text-meta">
        <dt className="text-ink-3">Blockchain</dt>
        <dd>{chainLabel(anchor.chainId)}</dd>
        <dt className="text-ink-3">App version</dt>
        <dd className="font-mono">{anchor.deploymentId}</dd>
        {Object.entries(anchor.contracts).map(([name, address]) => (
          <div key={name} className="contents">
            <dt className="text-ink-3">{name}</dt>
            <dd>
              <ExplorerLink href={addressUrl(chain, address)} title={address} className="font-mono">
                {shortHash(address, 8, 6)}
              </ExplorerLink>
            </dd>
          </div>
        ))}
        <dt className="text-ink-3">Latest block</dt>
        <dd data-testid="anchor-head">
          {anchor.head ? (
            <>
              <ExplorerLink href={blockUrl(chain, anchor.head.number)}>#{anchor.head.number.toLocaleString("en-US")}</ExplorerLink>
              <span className="block font-mono text-[0.6875rem] leading-snug break-all text-ink-3">{anchor.head.hash}</span>
            </>
          ) : (
            <span className="text-ink-3">none in the bundle</span>
          )}
        </dd>
      </dl>
      <details className="group text-meta" data-testid="anchor-txs">
        <summary className="-my-3 inline-flex min-h-10 cursor-pointer list-none items-center gap-1 rounded-sm font-medium text-ink outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden className="size-3.5 transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none" />
          {anchor.txHashes.length} {anchor.txHashes.length === 1 ? "transaction" : "transactions"} with a receipt
        </summary>
        {anchor.txHashes.length > 0 ? (
          <ul className="mt-2 grid gap-1 pl-4.5">
            {anchor.txHashes.map((hash) => (
              <li key={hash}>
                <ExplorerLink href={txUrl(chain, hash)} title={hash} className="font-mono">
                  {shortHash(hash, 10, 8)}
                </ExplorerLink>
              </li>
            ))}
          </ul>
        ) : null}
      </details>
    </section>
  );
}
