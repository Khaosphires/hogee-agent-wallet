import { Fragment } from "react";
import type { Exception, ExceptionKind } from "@hogee/core";
import { HexValue } from "@/components/ledger/hash";
import { Money } from "@/components/ledger/money";
import { PayoutRail } from "@/components/ledger/payout-rail";
import { requestDetail, type DetailValue } from "./officer-model";

const DETAIL = "grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg bg-canvas px-3.5 py-3 text-footnote text-ink";
const MONO = "font-mono text-[0.78125rem] break-all";

/** The test ids these two blocks had before every kind got its detail (kept around the shared block). */
const KEPT_TESTID: Partial<Record<ExceptionKind, string>> = { POLICY_ESCALATION: "escalation-payment", WITHDRAW_RESERVE: "reserve-withdrawal" };

function Value({ value, currency }: { value: DetailValue; currency?: string }) {
  switch (value.kind) {
    case "text":
      return <span>{value.text}</span>;
    case "money":
      return (
        <span className="font-medium">
          <Money minor={value.minor} />
        </span>
      );
    case "id":
      return (
        <span>
          {value.before ? `${value.before} ` : null}
          <span className={MONO}>{value.id}</span>
          {value.rail ? (
            <>
              {" "}
              <PayoutRail currency={currency} />
            </>
          ) : null}
        </span>
      );
    case "code":
      // A whole code (66 characters) takes the block's full width under its label on a phone, a few lines, not a
      // column of six-letter lines beside it (rcfix H-4).
      return value.full ? <HexValue value={value.hex} full className="max-sm:col-span-2" /> : <HexValue value={value.hex} />;
  }
}

/**
 * What the officer approves, or lets happen by not vetoing during the wait: the target, the new value, the payee and
 * the amount, from the request's typed payload (officer-model requestDetail), never from the title the server wrote.
 */
export function ExceptionDetail({ e, currency }: { e: Exception; currency?: string }) {
  const block = (
    <span className={DETAIL} data-testid="exception-detail" data-kind={e.kind}>
      {requestDetail(e, currency).map((row) => (
        <Fragment key={row.label}>
          <span className="text-ink-3">{row.label}</span>
          <Value value={row.value} currency={currency} />
        </Fragment>
      ))}
    </span>
  );
  const kept = KEPT_TESTID[e.kind];
  return kept ? (
    <span className="grid" data-testid={kept}>
      {block}
    </span>
  ) : (
    block
  );
}
