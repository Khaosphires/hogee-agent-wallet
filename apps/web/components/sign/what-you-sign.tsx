import { ArrowDown, ArrowUp, ChevronRight, CircleCheck, Info, ShieldAlert } from "lucide-react";
import type { SignatureRequestResponse } from "@hogee/core";
import { Pill } from "@/components/ui/pill";
import { signSummary } from "@/lib/sign-summary";
import { signedRows, type SignedRow } from "@/lib/signed-rows";
import type { DigestCheck } from "@/lib/typed-data";
import { cn } from "@/lib/utils";
import { expiresIn, zonedDateTime } from "./seal-time";

/** A less strict rule is what Mei must notice (waiting tone); a stricter one is a plain note. Neither is a stamp or a payment. */
const EFFECT_PILL = {
  loosen: (
    <Pill tone="waiting" icon={<ArrowUp aria-hidden className="size-[13px]" />}>
      Less strict
    </Pill>
  ),
  tighten: (
    <Pill tone="neutral" icon={<ArrowDown aria-hidden className="size-[13px]" />}>
      Stricter
    </Pill>
  ),
  neutral: null,
} as const;

/** "Co., Ltd." stays as it is; any other name gets the sentence's full stop. */
const withPeriod = (name: string): string => (name.endsWith(".") ? name : `${name}.`);

/** The rows a request shows, decoded in the browser from the message the digest covers (only once the check passed). */
export const rowsOf = (request: SignatureRequestResponse, check: DigestCheck, currency: string | undefined): SignedRow[] =>
  check.ok ? signedRows(request.typedData, check.webOrder, check.schedule, currency) : [];

/**
 * The top of the plain sign sheet (UX-PLAN D16, G1, G4): the summary the browser wrote from the signed data, the payee
 * name and account ending, the browser's own check line (always visible, above the button), and for a web supplier
 * the unverified line. A failed check turns the summary red and says not to sign.
 */
export function SignOverview({ request, check, currency, nowMs }: { request: SignatureRequestResponse; check: DigestCheck; currency: string | undefined; nowMs: number }) {
  const summary = signSummary(request.typedData, check, currency);
  const briefs = rowsOf(request, check, currency).flatMap((r) => (r.brief ? [{ ...r.brief, mono: r.mono }] : []));
  const expiry = expiresIn(Number(request.expiresAt), nowMs);
  return (
    <div className="grid gap-3">
      <div
        data-testid="sign-summary"
        data-ok={summary.ok}
        className={cn("grid gap-1.5 rounded-lg px-3.5 py-3 text-ui text-pretty", summary.ok ? "bg-sunk text-ink" : "bg-blocked-wash font-medium text-blocked")}
        role={summary.ok ? undefined : "alert"}
      >
        {summary.sentences.map((sentence) => (
          <p key={sentence}>{sentence}</p>
        ))}
      </div>
      {briefs.length > 0 ? (
        <dl className="grid gap-x-3 gap-y-1 px-0.5 text-ui sm:grid-cols-[10rem_minmax(0,1fr)]" data-testid="sign-key-facts">
          {briefs.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-ink-2">{row.label}</dt>
              <dd className={cn("min-w-0 font-medium break-words text-ink", row.mono && "tabular-nums")}>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {check.webOrder ? (
        <p className="flex gap-2 rounded-lg px-3.5 py-2.5 text-[0.8125rem] text-pretty text-ink-2 shadow-[inset_0_0_0_1px_var(--line-2)]" data-testid="sign-unverified">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-medium text-ink">Unverified web supplier:</strong> nobody has checked who they are. You&apos;re approving payment to the bank
            account of {withPeriod(check.webOrder.holderName)}
          </span>
        </p>
      ) : null}
      <div className="grid gap-0.5 px-0.5">
        <p className={cn("flex items-start gap-1.5 text-[0.8125rem] font-medium text-pretty", check.ok ? "text-paid" : "text-blocked")} data-testid="digest-check" data-ok={check.ok}>
          {check.ok ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" /> : <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />}
          <span>{check.ok ? "Checked by this browser: what you see is exactly what your passkey signs." : `Don't sign: ${check.reason}.`}</span>
        </p>
        {expiry ? <p className="pl-[22px] text-meta text-ink-3">This request expires {expiry}.</p> : null}
      </div>
    </div>
  );
}

/**
 * "Show details" (project.md §13.1 principle 5, T27): every row decoded from the message fields the digest covers, the
 * code the passkey signs (the digest) with where it is valid, and the server's notes, kept apart and marked as not
 * signed. Folded, never removed: the e2e opens it with showSignDetails(dialog).
 */
export function SignDetails({ request, check, currency }: { request: SignatureRequestResponse; check: DigestCheck; currency: string | undefined }) {
  const dm = request.displayModel;
  const rows = rowsOf(request, check, currency);
  return (
    <details className="group/details -mx-1 rounded-lg" data-testid="sign-details">
      <summary className="flex h-10 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 text-ui font-medium text-ink-2 outline-none select-none hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 transition-transform duration-(--dur-state) ease-settle group-open/details:rotate-90" />
        Show details
      </summary>
      <div className="grid gap-4 px-1 pt-1 pb-1">
        {rows.length > 0 ? (
          <ul className="divide-y divide-line overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--line)]" aria-label="What you sign">
            {rows.map((row, i) => (
              <li key={`${row.label}-${i}`} data-effect={row.effect} className="grid gap-1 px-3.5 py-2.5 text-ui sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-3">
                <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
                  {row.label}
                  {EFFECT_PILL[row.effect]}
                </span>
                <span className={cn("min-w-0 break-words text-ink-2", row.mono && "font-mono text-[0.78125rem] break-all")}>{row.value}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="grid gap-1.5 rounded-lg bg-sunk px-3.5 py-3">
          <p className="text-meta font-medium text-ink-3">The code your passkey signs</p>
          <p className="font-mono text-[0.78125rem] leading-5 tracking-[-0.01em] break-all text-ink" data-testid="sign-digest">
            {request.digest}
          </p>
          <p className="text-meta text-ink-3">
            Rule program <span className="font-mono break-all">{dm.contract}</span> · blockchain {dm.chainId} · app version {dm.deploymentId} · expires{" "}
            {zonedDateTime(Number(request.expiresAt), currency) ?? request.expiresAt}
          </p>
        </div>
        {check.ok ? (
          <details className="group rounded-lg px-3.5 py-2.5 text-[0.8125rem] shadow-[0_0_0_1px_var(--line)]" data-testid="server-description">
            <summary className="-my-2.5 cursor-pointer py-2.5 text-ink-2 outline-none select-none hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/50">
              Extra notes from Hogee (not part of what you sign)
            </summary>
            <ul className="mt-2 grid gap-1.5 pb-1">
              <li className="grid gap-1 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-3">
                <span className="font-medium text-ink">Title</span>
                <span className="min-w-0 break-words text-ink-2">{dm.title}</span>
              </li>
              {dm.rows.map((row, i) => (
                <li key={`${row.label}-${i}`} className="grid gap-1 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-3">
                  <span className="font-medium text-ink">{row.label}</span>
                  <span className="min-w-0 break-words text-ink-2">{row.value}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </details>
  );
}
