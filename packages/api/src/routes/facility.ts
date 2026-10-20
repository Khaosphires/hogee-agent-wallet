/**
 * §26.1 step 0 and 4 (officer only): POST /api/facility/open and /api/facility/fund. The API writes the rows and an
 * unsigned chain action; the worker signs with the server-held demo LENDER key.
 *
 * openFacility also seeds the tenant: the founder row and the static platform payees. Each platform payee's payout
 * account must hash to the value Treasury fixed at deploy (platformPayoutAccountHash), or nothing opens: a payout can
 * only ever go to an account the deployment committed to (T1). On Anvil it records a chain snapshot for demo reset.
 * The currency, the founder's country and the payees all come from the server's HOGEE_COUNTRY (SG-DESIGN fail-open
 * 2): a config currency or a catalog payee of another country is refused before the chain is read or a row written.
 */
import { jcs, parseMinor, type ChainAction, type CountryCode, type CurrencyCode } from "@hogee/core";
import type { ApiDeps, OnboardedPayee, Scope } from "../context";
import { lineKeyToLineId, shortIdToBytes32 } from "../chain-lib";
import { payoutHashOf, requireCountryPayees } from "../catalog/payees";
import type { RouteGroup } from "../http/register";
import { ConfigError, contractFailure, fail } from "../http/problem";
import { currencyFor } from "../runtime/env";
import { insertAction, liveAction, wake } from "../services/actions";
import { currentPlanOnChain, facilityOnChain, lenderOnChain, platformPayoutHash } from "../services/chain";
import { facilityRow, requireFacility } from "../services/facility";
import { newId } from "../services/ids";
import { pool, inTx } from "../services/sql";
import { appendTrace } from "../services/traces";

interface CountrySet {
  readonly country: CountryCode;
  readonly currency: CurrencyCode;
  readonly payees: readonly OnboardedPayee[];
}

/** The server country's currency and payees; a config currency or a catalog payee of another country is refused. */
async function countrySet(deps: ApiDeps): Promise<CountrySet> {
  const country = deps.config.countryCode;
  const currency = currencyFor(country);
  if (deps.config.currency !== currency) throw new ConfigError(`The currency ${deps.config.currency} is not ${country}'s (${currency})`);
  const catalog = await deps.catalog.payees();
  try {
    return { country, currency, payees: requireCountryPayees(country, catalog) };
  } catch (error: unknown) {
    throw new ConfigError(error instanceof Error ? error.message : `The payee catalog is not ${country}'s`);
  }
}

async function checkPlatformPayees(deps: ApiDeps, payees: readonly OnboardedPayee[]): Promise<void> {
  for (const p of payees) {
    if (p.source !== "platform") continue;
    const onChain = await platformPayoutHash(deps, shortIdToBytes32(p.payeeId));
    if (onChain.toLowerCase() !== payoutHashOf(p)) {
      throw fail("UPSTREAM", `The platform payee ${p.payeeId} is not the account this deployment committed to`);
    }
  }
}

/** Anvil only: a chain snapshot taken before the facility exists, so POST /api/demo/reset can return to step 0. */
async function anvilBaseline(deps: ApiDeps): Promise<string | null> {
  if (deps.config.chain !== "local" || deps.deployment.chainId !== 31337) return null;
  try {
    return (await deps.client.request({ method: "evm_snapshot" } as never)) as string;
  } catch {
    return null;
  }
}

async function openFacility(deps: ApiDeps, scope: Scope, capMinor: string, reserveFloorBps: number): Promise<ChainAction> {
  const db = pool(deps.db);
  const existing = await facilityRow(db, scope);
  if (existing) {
    const same = existing.cap_minor === capMinor && Number(existing.reserve_floor_bps) === reserveFloorBps && existing.currency === currencyFor(deps.config.countryCode);
    const action = await liveAction(db, scope.facilityId, "Treasury.openFacility", scope.facilityId);
    if (same && action) return action; // a retry of the same request
    throw fail("CONFLICT", "The facility is already open with other terms");
  }
  const set = await countrySet(deps);
  if ((await facilityOnChain(deps)).opened) throw fail("CONFLICT", "This deployment's facility is already open");
  await checkPlatformPayees(deps, set.payees);
  const lender = (await lenderOnChain(deps)).toLowerCase();
  const baseline = await anvilBaseline(deps);
  const action = await inTx(deps.db, async (q) => {
    await q.query(
      `insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [scope.facilityId, capMinor, set.currency, reserveFloorBps, lender, deps.deployment.deploymentId, deps.deployment.chainId],
    );
    // No name, national ID or phone: only what signing needs (§12.2). Residency is refined in the chat.
    await q.query(`insert into founders (id, facility_id, country, residency, wallet_address) values ($1, $2, $3, 'citizen', $4) on conflict do nothing`, [
      scope.founderId,
      scope.facilityId,
      set.country,
      deps.config.founderWallet,
    ]);
    for (const p of set.payees.filter((x) => x.source === "platform")) {
      await q.query(
        `insert into payees (id, facility_id, kind, display_name, xendit_account_ref, payout_account_hash, bound_line_ids, status)
         values ($1, $2, 'platform', $3, $4, $5, $6, 'BOUND') on conflict do nothing`,
        [p.payeeId, scope.facilityId, p.displayName, jcs(p.account), payoutHashOf(p), p.lineKey ? [lineKeyToLineId(p.lineKey)] : []],
      );
    }
    const created = await insertAction(q, {
      facilityId: scope.facilityId,
      kind: "Treasury.openFacility",
      refId: scope.facilityId,
      request: { capMinor, reserveFloorBps, ...(baseline ? { anvilBaseline: baseline } : {}) },
    });
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId: newId("trace"),
      actor: "officer",
      kind: "TX",
      summary: `Loan officer opened the facility: cap ${capMinor} minor, reserve floor ${reserveFloorBps} bps (signed by the demo lender key in the worker)`,
    });
    return created;
  });
  await wake(deps, "relay");
  return action;
}

async function fundFacility(deps: ApiDeps, scope: Scope, amountMinor: string): Promise<ChainAction> {
  const db = pool(deps.db);
  await requireFacility(db, scope);
  const onChain = await facilityOnChain(deps);
  if (!onChain.opened) throw fail("CONFLICT", "The facility is not open on-chain yet");
  const amount = parseMinor(amountMinor);
  if (amount === 0n) throw fail("VALIDATION", "Fund a positive amount");
  // Treasury.fund: funded + amount ≤ the committed plan's total and ≤ the cap (no plan yet → nothing can be funded).
  const planTotal = (await currentPlanOnChain(deps)).totalMinor;
  const ceiling = planTotal < onChain.capMinor ? planTotal : onChain.capMinor;
  if (onChain.fundedMinor + amount > ceiling) {
    const why = planTotal === 0n ? "fund after the founder's plan is committed" : `capped at ${ceiling} minor (the facility cap and the plan total); ${onChain.fundedMinor} is funded`;
    throw contractFailure("CapExceeded", `Funding refused: ${why}`);
  }
  const action = await inTx(deps.db, async (q) => {
    const created = await insertAction(q, { facilityId: scope.facilityId, kind: "Treasury.fund", refId: scope.facilityId, request: { amountMinor } });
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId: newId("trace"),
      actor: "officer",
      kind: "TX",
      summary: `Loan officer funded ${amountMinor} minor (budget units, signed by the demo lender key in the worker)`,
    });
    return created;
  });
  await wake(deps, "relay");
  return action;
}

export const facilityRoutes: RouteGroup = {
  openFacility: ({ req, deps, scope }) => openFacility(deps, scope, req.body.capMinor, req.body.reserveFloorBps),
  fundFacility: ({ req, deps, scope }) => fundFacility(deps, scope, req.body.amountMinor),
};
