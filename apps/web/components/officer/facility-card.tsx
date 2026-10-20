"use client";

import { useState, type FormEvent } from "react";
import { errorCopy } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApiMutation } from "@/lib/api/hooks";
import type { ApiClientError } from "@/lib/api/client";
import { parseBuInput, parsePctToBps } from "@/lib/format";
import { Receipt } from "./founder-enrolment";

function Result({ error, txHash }: { error: ApiClientError | null; txHash?: string }) {
  if (error) {
    return (
      <p className="text-[0.8125rem] text-blocked" role="alert">
        {errorCopy(error.code).title}: {error.message}
      </p>
    );
  }
  return txHash ? <Receipt txHash={txHash} /> : null;
}

export type OpenLoanMutation = ReturnType<typeof useOpenLoan>;
export const useOpenLoan = () => useApiMutation("openFacility");

/**
 * A refused second open (CONFLICT): the loan is already open (live: "This deployment's facility is already open").
 * The checklist then counts step 1 as done; nothing was changed.
 */
export const alreadyOpen = (error: ApiClientError | null): boolean => error?.code === "CONFLICT";

/** Step 1: open the loan with its limit and the minimum kept for tax (openFacility, signed by the demo lender key). */
export function OpenLoanBody({ open }: { open: OpenLoanMutation }) {
  const [cap, setCap] = useState("");
  const [floor, setFloor] = useState("");
  const capMinor = parseBuInput(cap);
  const floorBps = parsePctToBps(floor);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (capMinor && floorBps !== undefined) open.mutate({ body: { capMinor, reserveFloorBps: floorBps } });
  }
  if (alreadyOpen(open.error)) {
    return (
      <p className="text-[0.8125rem] text-ink-2" role="status">
        The loan was already open, so nothing changed.
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-2.5" aria-label="Open the loan">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor="cap">Loan limit (BU)</Label>
          <Input id="cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} className="w-36" />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="floor">Minimum kept for tax (%)</Label>
          <Input id="floor" inputMode="decimal" value={floor} onChange={(e) => setFloor(e.target.value)} className="w-36" />
        </div>
        <Button type="submit" disabled={!capMinor || floorBps === undefined || open.isPending}>
          Open the loan
        </Button>
      </div>
      <Result error={open.error} txHash={open.data?.txHash} />
    </form>
  );
}

export type AddMoneyMutation = ReturnType<typeof useAddMoney>;
export const useAddMoney = () => useApiMutation("fundFacility");

/**
 * Step 4: add money, up to the plan total (fund; the API and the contract cap it). The form keeps its accessible
 * name "Fund the facility", which e2e pins.
 */
export function AddMoneyBody({ fund, showForm }: { fund: AddMoneyMutation; showForm: boolean }) {
  const [amount, setAmount] = useState("");
  const amountMinor = parseBuInput(amount);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (amountMinor) fund.mutate({ body: { amountMinor } });
  }
  if (!showForm) return <Result error={fund.error} txHash={fund.data?.txHash} />;
  return (
    <form onSubmit={submit} className="grid gap-2.5" aria-label="Fund the facility">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor="fund-amount">Amount (BU)</Label>
          <Input id="fund-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-36" />
        </div>
        <Button type="submit" disabled={!amountMinor || fund.isPending}>
          Add money
        </Button>
      </div>
      <Result error={fund.error} txHash={fund.data?.txHash} />
    </form>
  );
}
