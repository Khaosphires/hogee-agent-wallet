"use client";

import { useState } from "react";
import { CircleCheck, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HexValue } from "@/components/ledger/hash";
import { Money } from "@/components/ledger/money";
import { PayoutRail } from "@/components/ledger/payout-rail";
import { ErrorBlock } from "@/components/ledger/query-state";
import { SignAction } from "@/components/sign/sign-action";
import { useApiMutation, useApiQuery } from "@/lib/api/hooks";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, uploadErrorText } from "@/lib/live-errors";
import { escrowMilestoneLabels } from "@/lib/milestone-labels";

/** The supplier's payments (§11 payment structure): automatic ones go after the wait; the balance needs the founder. */
export function EscrowCard({ orderId, currency }: { orderId: string; currency?: string }) {
  const escrow = useApiQuery("getEscrow", { params: { orderId } });
  const upload = useApiMutation("uploadInspection");
  const [file, setFile] = useState<File>();
  const tooBig = file !== undefined && file.size > MAX_UPLOAD_BYTES;
  const pending = escrow.data?.find((m) => !m.released && !m.autoRelease);
  // A web order (order-w…) has no sample: its auto milestone is the deposit (VISION-DECISIONS §9).
  const labels = escrow.data ? escrowMilestoneLabels(orderId, escrow.data) : [];
  return (
    <Card data-testid="escrow-card">
      <CardHeader>
        <CardTitle>Supplier payments</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>Order {orderId}. Hogee&apos;s AI pays the steps you already signed. The last payment waits for your delivery check.</span>
          <PayoutRail currency={currency} />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ErrorBlock error={escrow.error} what="the escrow order" />
        {escrow.data ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Payment</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Money set aside</TableHead>
                <TableHead>Paid?</TableHead>
                <TableHead>Delivery check</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {escrow.data.map((m) => (
                <TableRow key={m.idx} data-testid={`milestone-${m.idx}`}>
                  <TableCell className="font-medium">{labels[m.idx] ?? `Milestone ${m.idx + 1}`}</TableCell>
                  <TableCell className="text-right"><Money minor={m.amountMinor} currency={currency} /></TableCell>
                  <TableCell className="text-right"><Money minor={m.funded} /></TableCell>
                  <TableCell>
                    {m.released ? (
                      <span className="inline-flex items-center gap-1 text-finalized-foreground"><CircleCheck aria-hidden className="size-4" /> Paid</span>
                    ) : m.autoRelease ? (
                      "Paid automatically"
                    ) : (
                      "Needs your OK"
                    )}
                  </TableCell>
                  <TableCell>{m.evidenceHash ? <HexValue value={m.evidenceHash} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {pending ? (
          <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Inspection report</span>
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                className="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1"
                onChange={(e) => setFile(e.target.files?.[0])}
              />
            </label>
            <Button variant="outline" disabled={!file || tooBig || upload.isPending} onClick={() => file && upload.mutate({ params: { orderId }, body: { file } })}>
              <Upload /> Upload report
            </Button>
            <SignAction request={{ kind: "MilestoneRelease", refId: orderId }} label="Pay the balance" disabled={!pending.evidenceHash} />
            {tooBig ? (
              <p className="w-full text-sm text-destructive" data-testid="upload-too-big">
                This file is too big (over {MAX_UPLOAD_LABEL}). Please upload a smaller one, like a smaller PDF.
              </p>
            ) : null}
            {upload.error ? <p className="w-full text-sm text-destructive" data-testid="upload-error">{uploadErrorText(upload.error)}</p> : null}
            <p className="w-full text-xs text-muted-foreground">Only a check code of the file goes in the public record. The report itself stays private.</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
