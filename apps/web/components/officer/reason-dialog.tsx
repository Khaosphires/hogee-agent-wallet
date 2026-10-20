"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Asks for the reason a deny or veto needs (logged in the trace). */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirm: string;
  pending: boolean;
  error?: string;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim()) onSubmit(reason.trim());
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="reason">Reason</Label>
            <Input id="reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
            {error ? <p className="text-[0.8125rem] text-blocked">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending || !reason.trim()}>
              {confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
