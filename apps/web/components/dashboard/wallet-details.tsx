"use client";

/**
 * Proof → Wallet details (UX-PLAN D8): the wallet exactly as the blockchain counts it, for the loan officer and
 * reviewers, moved off Mei's Money page so it never contradicts Mei's four numbers. The treasury totals, the pockets
 * (raw: a supplier payment made from held money stays counted as held, not as spent), the AI's paying key, what the AI
 * did alone, and the reconciler's "records out of step" count. Read-only: no button here pays, stops or changes anything.
 * Mounted by the Proof page (ux-officer): `<WalletDetails />`, no props.
 *
 * Sales are the one figure every page shows (cfo-model salesFigure, from the CFO report, UX round 3 Steve #6 and
 * first-timer #39), tagged "Sample" by the Wallet's own rule (useSampleScope), never the balances' revenue. In a narrow
 * card (a phone, or beside the key's card) the pockets are a list, one row each: the eight-column table needs 48 rem.
 */
import { CircleCheck, CirclePause, OctagonAlert, ShieldAlert } from "lucide-react";
import type { Pocket } from "@hogee/core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { Pill } from "@/components/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorBlock, LoadingBlock, RefreshNote } from "@/components/ledger/query-state";
import { Meter } from "@/components/ledger/meter";
import { Money } from "@/components/ledger/money";
import { SampleTag, useSampleScope } from "@/components/cfo/cfo-parts";
import { salesFigure } from "@/components/cfo/cfo-model";
import { useAutonomy, useBalances, useCfoReport } from "@/lib/api/queries";
import { queryView } from "@/lib/api/query-policy";
import { bu, lineLabel, pctOf, shortHash, unixDate } from "@/lib/format";

function PocketStatus({ pocket }: { pocket: Pocket }) {
  if (pocket.circuitOpen) {
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <OctagonAlert aria-hidden className="size-4" /> Stopped itself
      </span>
    );
  }
  if (pocket.paused) {
    return (
      <span className="inline-flex items-center gap-1 text-ink-2">
        <CirclePause aria-hidden className="size-4" /> Paused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <CircleCheck aria-hidden className="size-4" /> Active
    </span>
  );
}

/** The sales row: the CFO report's figure (salesFigure), "Sample" where the Wallet would tag it; never a guess while it loads. */
function SalesValue() {
  const report = useCfoReport();
  const scope = useSampleScope();
  if (report.data) {
    return (
      <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
        <Money minor={salesFigure(report.data).soFarMinor} />
        {scope.figures ? <SampleTag /> : null}
      </span>
    );
  }
  return report.error ? <span className="font-normal text-ink-3">Not available</span> : <span className="text-ink-3" aria-label="Loading">…</span>;
}

function Totals({ b }: { b: { fundedMinor: string; releasedMinor: string; escrowMinor: string; reserveMinor: string } }) {
  const rows = [
    { key: "funded", label: "Money added by the loan officer", value: <Money minor={b.fundedMinor} /> },
    { key: "released", label: "Budget released so far", value: <Money minor={b.releasedMinor} /> },
    { key: "escrow", label: "Sent to the held box for suppliers (paid out or not)", value: <Money minor={b.escrowMinor} /> },
    { key: "reserve", label: "Kept for tax", value: <Money minor={b.reserveMinor} /> },
    { key: "revenue", label: "Sales", value: <SalesValue /> },
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {rows.map((r) => (
        <div key={r.key} data-testid={`chain-${r.key}`} className="flex justify-between gap-3 border-b border-line pb-2">
          <dt className="text-ink-2">{r.label}</dt>
          <dd className="text-right font-medium">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** In a narrow card: one row per pocket, what is left on the right, its spending and limits in short lines under the name. */
function PocketList({ pockets }: { pockets: readonly Pocket[] }) {
  return (
    <GroupedList inset={false} aria-label="Pockets" className="@3xl:hidden" data-testid="pockets-list">
      {pockets.map((p) => (
        <ListRow
          key={p.lineKey}
          data-testid={`pocket-row-${p.lineKey}`}
          title={lineLabel(p.lineKey)}
          value={
            <>
              <Money minor={p.available} /> left
            </>
          }
          subtitle={
            <>
              <span className="block">
                <Money minor={p.spent} /> spent of <Money minor={p.allocated} />
              </span>
              <span className="block">
                At most <Money minor={p.perTxCap} /> per payment
              </span>
              <span className="block">
                Last 7 days: {bu(p.windowSpent)} of {bu(p.windowCap)} · open until {unixDate(p.validUntil)}
              </span>
              <span className="mt-0.5 block">
                <PocketStatus pocket={p} />
              </span>
            </>
          }
        />
      ))}
    </GroupedList>
  );
}

export function WalletDetails() {
  const balances = useBalances();
  const autonomy = useAutonomy();
  const view = queryView(balances);

  return (
    <section id="wallet-details" aria-labelledby="wallet-details-title" data-testid="wallet-details" className="mt-12 scroll-mt-20 space-y-4">
      <div className="space-y-1">
        <h2 id="wallet-details-title" className="text-[1.0625rem] leading-6 font-semibold tracking-[-0.015em]">
          Wallet details
        </h2>
        <p className="text-ui text-pretty text-ink-2">The wallet exactly as the blockchain counts it, for your loan officer and reviewers. Nothing here can pay or change anything.</p>
      </div>
      {view.kind === "loading" ? <LoadingBlock rows={6} label="Reading the wallet" /> : null}
      {view.kind === "error" ? <ErrorBlock error={view.error} what="the wallet (nothing was paid or changed)" /> : null}
      {view.kind === "data" ? (
        <>
          <RefreshNote error={view.refreshFailed} what="wallet" />
          {view.data.paused ? (
            <Alert>
              <ShieldAlert />
              <AlertTitle>Automatic payments are paused</AlertTitle>
              <AlertDescription>
                <p>The AI can&apos;t pay anyone until the founder and the loan officer both agree to turn payments back on, and a waiting time passes.</p>
              </AlertDescription>
            </Alert>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Treasury totals</CardTitle>
            </CardHeader>
            <CardContent>
              <Totals b={view.data} />
            </CardContent>
          </Card>
          <div className="grid gap-6 xl:grid-cols-[1fr_320px] [&>*]:min-w-0">
            <Card>
              <CardHeader>
                <CardTitle>Pockets</CardTitle>
                <CardDescription className="text-pretty">
                  Each pocket has its own limits, as the blockchain counts them. Money paid to a supplier from the held box stays counted there, not under Spent.
                </CardDescription>
                <CardAction>
                  <Pill tone="outline" data-testid="pockets-on-chain">
                    On chain
                  </Pill>
                </CardAction>
              </CardHeader>
              <CardContent className="@container">
                <PocketList pockets={view.data.pockets} />
                <div className="hidden @3xl:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Pocket</TableHead>
                        <TableHead className="text-right">Budget</TableHead>
                        <TableHead className="text-right">Spent</TableHead>
                        <TableHead className="text-right">Left</TableHead>
                        <TableHead className="text-right">Most per payment</TableHead>
                        <TableHead className="w-48">Last 7 days</TableHead>
                        <TableHead>Open until</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {view.data.pockets.map((p) => (
                        <TableRow key={p.lineKey} data-testid={`pocket-${p.lineKey}`}>
                          <TableCell className="font-medium">{lineLabel(p.lineKey)}</TableCell>
                          <TableCell className="text-right"><Money minor={p.allocated} /></TableCell>
                          <TableCell className="text-right"><Money minor={p.spent} /></TableCell>
                          <TableCell className="text-right"><Money minor={p.available} /></TableCell>
                          <TableCell className="text-right"><Money minor={p.perTxCap} /></TableCell>
                          <TableCell>
                            <Meter pct={pctOf(p.windowSpent, p.windowCap)} label={`${bu(p.windowSpent)} of ${bu(p.windowCap)}`} />
                          </TableCell>
                          <TableCell>{unixDate(p.validUntil)}</TableCell>
                          <TableCell><PocketStatus pocket={p} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>The AI&apos;s paying key</CardTitle>
                  <CardDescription>Pays by itself, only inside the signed plan.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-1 text-sm">
                  <p className="font-mono text-xs" title={view.data.agent.address}>{shortHash(view.data.agent.address, 8, 6)}</p>
                  <p>{view.data.agent.revoked ? "Switched off" : `Works until ${unixDate(view.data.agent.expiresAt)}`}</p>
                  <p className="text-muted-foreground" data-testid="drift">Records out of step: {view.data.drift}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>What the AI did alone</CardTitle>
                  <CardDescription>Payments the AI made by itself, compared with payments a person signed.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-1 text-sm" data-testid="autonomy">
                  {autonomy.data ? (
                    <>
                      <p className="text-base font-semibold">
                        {autonomy.data.agentTxs} AI payments · {autonomy.data.humanSigs} signed by a person
                      </p>
                      <p className="text-muted-foreground">
                        {autonomy.data.autoPct}% done alone inside the plan, {autonomy.data.escalatedPct}% passed to a person · running {autonomy.data.hours} hours
                      </p>
                    </>
                  ) : autonomy.error ? (
                    <ErrorBlock error={autonomy.error} what="what the AI did alone" />
                  ) : (
                    <LoadingBlock rows={2} label="Counting payments" />
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
