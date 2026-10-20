"use client";

/**
 * The design system on one page (dev only, /dev/ui; DESIGN.md §12): every design value and primitive the ux2 pass added or
 * restyled, with sample content. Nothing here is real data or calls the API.
 */
import * as React from "react";
import {
  ArrowDownLeft,
  Bot,
  CircleCheck,
  Factory,
  Fingerprint,
  Megaphone,
  Package,
  Plus,
  ReceiptText,
  ShieldCheck,
  Store,
  Truck,
  UserRound,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AllocationBar, type AllocationItem } from "@/components/ledger/allocation-bar";
import { LINE_SLOT } from "@/components/ledger/line-slots";
import { Money } from "@/components/ledger/money";
import { EmptyState } from "@/components/ledger/query-state";
import { Seal } from "@/components/ledger/seal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GroupedList, ListRow } from "@/components/ui/grouped-list";
import { IconTile } from "@/components/ui/icon-tile";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill, Tag, UnverifiedPill } from "@/components/ui/pill";
import { Progress, ProgressRing } from "@/components/ui/progress";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { slotTone, TONES } from "@/components/ui/tones";

const TYPE = [
  ["text-large-title", "Large title", "34 / 40 · 700"],
  ["text-title-1", "Title 1", "28 / 34 · 700"],
  ["text-title-2", "Title 2", "22 / 28 · 600"],
  ["text-title-3", "Title 3", "20 / 25 · 600"],
  ["text-headline", "Headline", "17 / 22 · 600"],
  ["text-body", "Body", "16 / 24"],
  ["text-callout", "Callout", "15 / 21"],
  ["text-subhead", "Subhead", "14 / 20"],
  ["text-footnote", "Footnote", "13 / 18"],
  ["text-caption", "Caption", "12 / 16"],
  ["text-caption-2", "Caption 2", "11 / 13 · 500"],
] as const;

const SHADOWS = [
  ["shadow-sm", "sm · controls"],
  ["shadow-card", "card · on the canvas"],
  ["shadow-md", "md · raised"],
  ["shadow-lg", "lg · the lifted card"],
  ["shadow-pop", "pop · dialogs, sheets"],
] as const;

const RADII = [
  ["rounded-sm", "6 · tags"],
  ["rounded-md", "8 · small controls"],
  ["rounded-control", "12 · controls, wells"],
  ["rounded-group", "14 · grouped lists"],
  ["rounded-card", "18 · cards"],
  ["rounded-sheet", "24 · sheets, dialogs"],
] as const;

const POCKETS: readonly (AllocationItem & { icon: LucideIcon; rule: string })[] = [
  { key: "SUPPLIER", label: "Supplier", minor: "500000", slot: LINE_SLOT.SUPPLIER, icon: Factory, rule: "Paid in steps, held until delivery" },
  { key: "PACKAGING", label: "Packaging", minor: "150000", slot: LINE_SLOT.PACKAGING, icon: Package, rule: "Up to 375 BU a payment" },
  { key: "LOGISTICS", label: "Delivery", minor: "80000", slot: LINE_SLOT.LOGISTICS, icon: Truck, rule: "Up to 200 BU a payment" },
  { key: "ADS", label: "Ads", minor: "120000", slot: LINE_SLOT.ADS, icon: Megaphone, rule: "Up to 75 BU a day" },
  { key: "PLATFORM_FEES", label: "Marketplace fees", minor: "50000", slot: LINE_SLOT.PLATFORM_FEES, icon: Store, rule: "Up to 125 BU a payment" },
  { key: "CONTINGENCY", label: "Safety buffer", minor: "100000", slot: LINE_SLOT.CONTINGENCY, icon: ShieldCheck, rule: "Up to 250 BU a payment" },
];
const USED_PCT: Record<string, number> = { SUPPLIER: 30, PACKAGING: 62, LOGISTICS: 18, ADS: 84, PLATFORM_FEES: 40, CONTINGENCY: 0 };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4">
      <h2 className="text-title-2 text-ink">{title}</h2>
      {children}
    </section>
  );
}

export function KitchenSink() {
  const [period, setPeriod] = React.useState<"4w" | "loan">("4w");
  const [filter, setFilter] = React.useState<"all" | "in" | "out">("all");
  return (
    <div className="grid gap-12 pb-16">
      <header className="grid gap-1">
        <h1 className="text-page text-ink">Design system</h1>
        <p className="text-subhead text-ink-2">Developer page: the ux2 type, colour, depth and primitives with sample content. Not real data.</p>
      </header>

      <Section title="Figures">
        <div className="grid gap-4 sm:grid-cols-[1.4fr_1fr_1fr]">
          <Card className="px-5">
            <Stat label="Ready to spend" minor="400000" size="hero" tick leading={<IconTile icon={Wallet} tone="ink" size="sm" />} note="Of 10,000 BU in your plan." />
          </Card>
          <Card className="px-5">
            <Stat label="Sales this week" minor="135600" tick leading={<IconTile icon={ArrowDownLeft} tone="paid" size="sm" />} delta={{ text: "+18% on last week", trend: "up", upIsGood: true }} />
          </Card>
          <Card className="px-5">
            <Stat label="Orders" value={32} unit="orders" tick leading={<IconTile icon={Package} tone="slot-1" size="sm" />} delta={{ text: "−2 on last week", trend: "down", upIsGood: true }} />
          </Card>
        </div>
      </Section>

      <Section title="Grouped lists">
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <GroupedList header="Pockets" headerAction={<Button variant="plain" size="sm">See plan</Button>} footer="Your wallet pays only from these, up to their limits.">
            {POCKETS.map((p) => (
              <ListRow
                key={p.key}
                leading={<IconTile icon={p.icon} tone={slotTone(p.slot)} />}
                title={p.label}
                subtitle={p.rule}
                value={<Money minor={p.minor} />}
                href={`#pocket-${p.key.toLowerCase()}`}
              />
            ))}
          </GroupedList>
          <div className="grid gap-6">
            <GroupedList header="Activity" footer="Sample entries.">
              <ListRow leading={<IconTile icon={ArrowDownLeft} tone="paid" />} title="Shopee sale" subtitle="2 h ago" value={<span className="text-paid">+48 BU</span>} />
              <ListRow leading={<IconTile icon={Bot} tone="agent" />} title="Deposit paid automatically" subtitle="Under your seal · yesterday" value={<Money minor="75000" />} trailing={<Pill tone="agent">Agent paid</Pill>} />
              <ListRow leading={<IconTile icon={UserRound} tone="waiting" />} title="Balance waits for you" subtitle="Upload the delivery check" trailing={<Pill tone="waiting">Waiting on you</Pill>} onClick={() => undefined} />
              <ListRow leading={<IconTile icon={Fingerprint} tone="seal" />} title="You signed your plan" subtitle="12 Oct" trailing={<Seal size={20} />} />
            </GroupedList>
            <GroupedList header="Settings" aria-label="Settings sample">
              <ListRow leading={<IconTile icon={UserRound} tone="grey" />} title="Profile" value="Mei Tan" href="#profile" />
              <ListRow leading={<IconTile icon={ShieldCheck} tone="paid" />} title="Passkey" value="Set up" href="#passkey" selected />
              <ListRow leading={<IconTile icon={ReceiptText} tone="ink" />} title="Receipts" href="#receipts" />
            </GroupedList>
          </div>
        </div>
      </Section>

      <Section title="Icon tiles">
        <Card className="px-5">
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-3">
              {TONES.map((tone) => (
                <IconTile key={tone} icon={tone === "seal" ? Fingerprint : CircleCheck} tone={tone} label={`${tone}, solid`} />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {TONES.map((tone) => (
                <IconTile key={tone} icon={tone === "seal" ? Fingerprint : CircleCheck} tone={tone} variant="tinted" label={`${tone}, tinted`} />
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {(["sm", "md", "lg", "xl"] as const).map((size) => (
                <IconTile key={size} icon={Truck} tone="slot-3" size={size} label={`size ${size}`} />
              ))}
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Controls">
        <Card className="px-5">
          <div className="grid gap-6">
            <div className="flex flex-wrap items-center gap-3">
              <Button>Sign with passkey</Button>
              <Button variant="tinted">Show details</Button>
              <Button variant="secondary">Change something</Button>
              <Button variant="plain">Later</Button>
              <Button variant="ghost">Cancel</Button>
              <Button variant="destructive">Stop this payment</Button>
              <Button variant="link">Open the receipt</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm">Small</Button>
              <Button>Default</Button>
              <Button size="lg">
                <Fingerprint />
                Large
              </Button>
              <Button size="xl">Extra large</Button>
              <Button size="icon" variant="tinted" aria-label="Add">
                <Plus />
              </Button>
              <Button size="icon-sm" variant="secondary" aria-label="Add, small">
                <Plus />
              </Button>
            </div>
            <div className="grid gap-3 sm:max-w-md">
              <Segmented aria-label="Period" value={period} onValueChange={setPeriod} items={[{ value: "4w", label: "Last 4 weeks" }, { value: "loan", label: "Since the loan" }]} />
              <Segmented
                aria-label="Show"
                size="sm"
                value={filter}
                onValueChange={setFilter}
                items={[
                  { value: "all", label: "All" },
                  { value: "in", label: "Money in" },
                  { value: "out", label: "Money out" },
                ]}
              />
            </div>
            <Tabs defaultValue="overview">
              <TabsList aria-label="Sample tabs">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="spending">Spending</TabsTrigger>
                <TabsTrigger value="sales">Sales</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="text-subhead text-ink-2">Tabs use the segmented look by default.</TabsContent>
              <TabsContent value="spending" className="text-subhead text-ink-2">Spending panel.</TabsContent>
              <TabsContent value="sales" className="text-subhead text-ink-2">Sales panel.</TabsContent>
            </Tabs>
            <div className="grid gap-2 sm:max-w-sm">
              <Label htmlFor="ks-name">Business name</Label>
              <Input id="ks-name" placeholder="e.g. Mei's Tumblers" />
              <Label htmlFor="ks-bad">Amount</Label>
              <Input id="ks-bad" aria-invalid defaultValue="12.5.0" />
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Capsules">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="waiting">Waiting on you</Pill>
          <Pill tone="signed">Signed</Pill>
          <Pill tone="paid">Paid</Pill>
          <Pill tone="agent">Agent pays</Pill>
          <Pill tone="cooling">Cooling</Pill>
          <Pill tone="blocked">Blocked</Pill>
          <Pill tone="neutral">Paused</Pill>
          <UnverifiedPill />
          <Badge>Badge</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Sample data</Badge>
          <Tag>AI-drafted</Tag>
        </div>
      </Section>

      <Section title="Progress">
        <Card className="px-5">
          <div className="grid gap-6">
            <AllocationBar items={POCKETS} totalMinor="1000000" rows={false} />
            <div className="flex flex-wrap gap-5">
              {POCKETS.map((p) => (
                <div key={p.key} className="grid justify-items-center gap-1.5">
                  <ProgressRing value={USED_PCT[p.key] ?? 0} tone={slotTone(p.slot)} size={52} stroke={5} label={`${p.label}: ${USED_PCT[p.key]}% used`}>
                    {USED_PCT[p.key]}%
                  </ProgressRing>
                  <span className="text-caption text-ink-2">{p.label}</span>
                </div>
              ))}
            </div>
            <div className="grid gap-3 sm:max-w-md">
              <Progress value={62} tone="slot-2" aria-label="Packaging used" />
              <Progress value={84} tone="waiting" aria-label="Ads used" />
              <Progress value={100} tone="paid" aria-label="Sales goal" />
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Cards and tables">
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Your budget</CardTitle>
              <CardDescription>How your 10,000 BU is split.</CardDescription>
              <CardAction>
                <Pill tone="signed">Signed</Pill>
              </CardAction>
            </CardHeader>
            <CardContent>
              <AllocationBar items={POCKETS} totalMinor="1000000" />
            </CardContent>
          </Card>
          <div className="grid gap-6">
            <Table grouped aria-label="Sample payments">
              <TableHeader>
                <TableRow>
                  <TableHead>Payment</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Supplier deposit</TableCell>
                  <TableCell className="text-ink-2">14 Oct</TableCell>
                  <TableCell className="text-right">
                    <Money minor="75000" />
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Shopee ads</TableCell>
                  <TableCell className="text-ink-2">16 Oct</TableCell>
                  <TableCell className="text-right">
                    <Money minor="7500" />
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <Card className="px-5">
              <EmptyState icon={<ReceiptText />} title="No payments yet">
                Payments show here with a receipt you can check.
              </EmptyState>
            </Card>
            <Card className="px-5">
              <div className="grid gap-2.5" aria-busy="true" aria-label="Loading sample">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-16 w-full rounded-lg" />
              </div>
            </Card>
          </div>
        </div>
      </Section>

      <Section title="Type">
        <Card className="px-5">
          <ul className="grid gap-3">
            {TYPE.map(([cls, name, spec]) => (
              <li key={cls} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 shadow-[inset_0_-1px_0_var(--separator)] pb-3 last:shadow-none">
                <span className={`${cls} text-ink`}>{name}</span>
                <code className="font-mono text-caption text-ink-3">
                  {cls} · {spec}
                </code>
              </li>
            ))}
          </ul>
        </Card>
      </Section>

      <Section title="Depth and radius">
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-5">
          {SHADOWS.map(([cls, name]) => (
            <div key={cls} className={`grid h-24 place-items-center rounded-card bg-raised p-3 text-center text-caption text-ink-2 ${cls}`}>
              {name}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-6">
          {RADII.map(([cls, name]) => (
            <div key={cls} className={`grid h-20 place-items-center bg-tint-3 p-2 text-center text-caption text-slot-3-ink ${cls}`}>
              {name}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
