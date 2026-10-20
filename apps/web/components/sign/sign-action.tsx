"use client";

import { useState } from "react";
import { Fingerprint } from "lucide-react";
import type { ChainAction } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { SignDialog, type SignRequest } from "./sign-dialog";

/** A button that opens the generic SignDialog for one signature kind and record. */
export function SignAction({
  request,
  label,
  title,
  disabled,
  variant = "default",
  onDone,
}: {
  request: SignRequest;
  label: string;
  /** The sign sheet's title (default: a plain title for the kind, never the server's). */
  title?: string;
  disabled?: boolean;
  variant?: "default" | "outline";
  onDone?: (action: ChainAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  return (
    <>
      <Button
        variant={variant === "outline" ? "secondary" : "default"}
        disabled={disabled}
        onClick={() => {
          setSession((n) => n + 1);
          setOpen(true);
        }}
      >
        <Fingerprint /> {label}
      </Button>
      {session > 0 ? <SignDialog key={session} request={request} title={title} open={open} onOpenChange={setOpen} onDone={onDone} /> : null}
    </>
  );
}
