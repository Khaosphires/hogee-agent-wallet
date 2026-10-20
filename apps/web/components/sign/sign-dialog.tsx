"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Fingerprint, KeyRound, OctagonAlert, Wallet } from "lucide-react";
import { CONSTITUTION_CODES, CONSTITUTION_CODE_UINT8, CONSTITUTION_COPY, errorCopy, type ChainAction, type SignMethod, type SignatureKind, type SignatureRequestResponse } from "@hogee/core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingBlock } from "@/components/ledger/query-state";
import { ApiClientError, apiCall } from "@/lib/api/client";
import { refreshAfterAction } from "@/lib/api/hooks";
import { useDisplayCurrency } from "@/lib/api/queries";
import { useSession } from "@/lib/api/use-session";
import { ALREADY_ON_DEVICE, PROMPT_CANCELLED, RegistrationFailure, alreadyOnDevice, registrationErrorText } from "@/lib/enrolment";
import { passkeySubmission, passkeysSupported, registerFounderPasskey, storedCredentialId } from "@/lib/passkey";
import { signGate } from "@/lib/sign-summary";
import { checkSignatureRequest, metaMaskTypedData } from "@/lib/typed-data";
import { useNow } from "@/lib/use-now";
import { EnrolmentForm } from "./enrolment-form";
import { passkeyIdSuffix } from "./passkey-setup-card";
import { SealStub, useSealMoment } from "./seal-stub";
import { signerName, zoneCurrency } from "./seal-time";
import { SignButton } from "./sign-button";
import { SignDetails, SignOverview } from "./what-you-sign";

export interface SignRequest {
  readonly kind: SignatureKind;
  readonly refId: string;
}

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const ethereum = (): Eip1193 | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { ethereum?: Eip1193 }).ethereum);

/**
 * Plain-English failure, including which constitution rule a PlanInvariantViolated(code) names. A refused signature
 * shows the server's reason (unknown key, other challenge, no wallet registered…), which says what to do next.
 */
function describe(error: unknown): string {
  if (error instanceof ApiClientError) {
    const copy = errorCopy(error.code);
    if (error.code === "InvalidSignature" && error.message) return `${copy.title}. ${error.message}.`;
    const raw = error.contractError?.args?.code;
    const rule = raw ? CONSTITUTION_CODES.find((c) => String(CONSTITUTION_CODE_UINT8[c]) === raw) : undefined;
    return `${copy.title}. ${rule ? `${CONSTITUTION_COPY[rule]}. ` : ""}${copy.detail}`;
  }
  if (error instanceof Error && error.name === "NotAllowedError") return PROMPT_CANCELLED;
  return error instanceof Error ? error.message : String(error);
}

/** The sheet's title when the opener gives none: the client's words, never the server's (UX-PLAN D16, D18). */
const KIND_TITLE: Record<SignatureKind, string> = {
  PlanApproval: "Sign your plan",
  SupplierApproval: "Approve paying this supplier",
  MilestoneRelease: "Pay your supplier",
  LoosenRequest: "Ask to change a rule",
  StageRelease: "Approve the next part of your budget",
  OwnerSpend: "Pay an invoice yourself",
};

/** How a signature was made, as the seal words it. */
export type SignMethodUsed = "passkey" | "wallet";

export function SignDialog({
  request,
  title,
  open,
  onOpenChange,
  initial,
  onDone,
}: {
  request: SignRequest;
  /** The opener's own title for this signature; the server's title only shows in the details, as a note. */
  title?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A request the server already made (e.g. exception approve → SIGNATURE_REQUIRED). */
  initial?: SignatureRequestResponse;
  /** After the submit: the chain action and how the founder signed (the seal says "with a passkey" or "with a wallet"). */
  onDone?: (action: ChainAction, method: SignMethodUsed) => void;
}) {
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<SignMethod>("passkey");
  const [openedAt] = useState(() => Date.now());
  const [busy, setBusy] = useState<"register" | "sign" | undefined>();
  const [error, setError] = useState<string>();
  const [action, setAction] = useState<ChainAction>();
  // When the signature landed, for the seal's time line (the API returns no timestamp; this is the browser's clock).
  const [signedAt, setSignedAt] = useState<string>();
  const [hasPasskey, setHasPasskey] = useState(() => Boolean(storedCredentialId()));
  const [offerNewPasskey, setOfferNewPasskey] = useState(false);
  // G2: creating a passkey needs the loan officer's one-time enrolment code, typed into EnrolmentForm.
  const [enrolling, setEnrolling] = useState(false);
  const [enrolError, setEnrolError] = useState<string>();
  const [created, setCreated] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const signButton = useRef<HTMLButtonElement>(null);

  const sig = useQuery({
    queryKey: ["requestSignature", request.kind, request.refId, method, openedAt],
    queryFn: () => apiCall("requestSignature", { body: { ...request, method } }),
    // A request the server already made (e.g. approve → SIGNATURE_REQUIRED) is used as is for the passkey path.
    enabled: open && (!initial || method !== "passkey"),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
  const req = method === "passkey" && initial ? initial : sig.data;
  const session = useSession().data;
  // Recomputed on every open: the dialog mounts per signing session and fetches a fresh request (G1).
  const check = useMemo(
    () => (req && session ? checkSignatureRequest(req, { kind: request.kind, chainId: session.chainId, deploymentId: session.deploymentId }) : undefined),
    [req, session, request.kind],
  );

  async function submit(body: Parameters<typeof apiCall<"submitSignature">>[1]) {
    const result = await apiCall("submitSignature", body);
    setSignedAt(new Date().toISOString());
    setAction(result);
    await refreshAfterAction(queryClient);
    onDone?.(result, method === "passkey" ? "passkey" : "wallet");
  }

  async function signWithPasskey() {
    // The handler checks the gate too, not only the disabled button (G1).
    if (!req || !canSign) return;
    setError(undefined);
    setNotice(undefined);
    setBusy("sign");
    try {
      await submit({ params: { id: req.requestId }, body: await passkeySubmission(req.digest as `0x${string}`) });
    } catch (e) {
      // The server refused this device's passkey. Nothing is deleted: live, that is the normal answer until the loan
      // officer registers the key (they review it from GET /api/officer/founder-key/pending). In the mock it can mean
      // a demo reset or restart cleared the keys, so offer a new passkey (with a new code) next to signing again.
      if (e instanceof ApiClientError && e.code === "InvalidSignature") {
        setOfferNewPasskey(true);
        const hint = session?.mode === "live" ? "Has your loan officer approved your passkey yet? If not, ask them to." : "If the demo was reset, create a new passkey.";
        setError(`${describe(e)} ${hint}`);
      } else {
        setError(describe(e));
      }
    } finally {
      setBusy(undefined);
    }
  }

  async function signWithMetaMask() {
    const eth = ethereum();
    if (!eth || !req || !canSign) return;
    setError(undefined);
    setBusy("sign");
    try {
      const [account] = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const signature = ((await eth.request({ method: "eth_signTypedData_v4", params: [account, metaMaskTypedData(req.typedData)] })) as string).toLowerCase();
      await submit({ params: { id: req.requestId }, body: { ecdsa: { signature } } });
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(undefined);
    }
  }

  function startEnrolment() {
    setError(undefined);
    setNotice(undefined);
    setEnrolError(undefined);
    setCreated(undefined);
    setEnrolling(true);
  }

  async function createPasskey(code: string) {
    setEnrolError(undefined);
    setBusy("register");
    try {
      const result = await registerFounderPasskey(code);
      setHasPasskey(true);
      setOfferNewPasskey(false);
      setEnrolling(false);
      setCreated(result.credentialId);
      setError(undefined);
      requestAnimationFrame(() => signButton.current?.focus());
    } catch (e) {
      if (e instanceof RegistrationFailure && alreadyOnDevice(e)) {
        // The device holds the founder's current key (excludeCredentials): signing with it is the way on, even when
        // this browser forgot its credential id (the passkey picker offers it).
        setHasPasskey(true);
        setOfferNewPasskey(false);
        setEnrolling(false);
        setNotice(ALREADY_ON_DEVICE);
        requestAnimationFrame(() => signButton.current?.focus());
        return;
      }
      setEnrolError(e instanceof RegistrationFailure ? registrationErrorText(e.step, e.error) : describe(e));
    } finally {
      setBusy(undefined);
    }
  }

  const { canSign, disabled: signDisabled } = signGate({ hasRequest: Boolean(req), checkOk: check?.ok, signed: Boolean(action), busy });
  const sealing = useSealMoment(Boolean(action));
  const currency = zoneCurrency(useDisplayCurrency(), session?.persona);
  const nowMs = useNow();
  const needsPasskey = method === "passkey" && !hasPasskey && !enrolling && !action;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title ?? KIND_TITLE[request.kind]}</DialogTitle>
          <DialogDescription>
            Your {method === "passkey" ? "passkey" : "wallet"} signs exactly what&apos;s shown here. Every line is under Show details.
          </DialogDescription>
        </DialogHeader>

        {method === "passkey" && enrolling && !action ? (
          // The code field comes first: without a passkey nothing below can be signed (UX-PLAN D1).
          <EnrolmentForm
            title={hasPasskey ? "Create a new passkey" : "Create your passkey"}
            busy={busy === "register"}
            error={enrolError}
            onSubmit={(code) => void createPasskey(code)}
            onCancel={() => setEnrolling(false)}
            onEdit={() => setEnrolError(undefined)}
          />
        ) : null}
        {created && !action ? (
          <p className="flex gap-2 rounded-lg bg-paid-wash px-3.5 py-3 text-[0.8125rem] text-pretty text-ink" role="status" data-testid="passkey-created">
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-paid" />
            <span>
              Passkey created on this device. Your passkey ID ends in <span className="font-mono text-[0.78125rem]">{passkeyIdSuffix(created)}</span>. Your loan officer
              must check and approve it before you can sign.
            </span>
          </p>
        ) : null}

        {sig.isFetching && !req ? <LoadingBlock rows={4} label="Preparing the signing request" /> : null}
        {sig.error ? (
          <p className="flex gap-2 rounded-lg bg-blocked-wash px-3.5 py-3 text-[0.8125rem] text-blocked" role="alert">
            <OctagonAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {describe(sig.error)}
          </p>
        ) : null}
        {req && check && !action ? <SignOverview request={req} check={check} currency={currency} nowMs={nowMs || Date.now()} /> : null}

        {action ? (
          // The stamp moment: the chop plays once, on this live transition to signed (DESIGN.md §4).
          <div role="status" data-testid="sign-done" className="stub -mx-5 -mb-5 grid gap-3 rounded-b-2xl px-5 py-4 before:hidden after:hidden sm:-mx-6 sm:-mb-6 sm:px-6">
            <p className="sr-only">Signed and sent.{action.txHash ? "" : " Hogee is saving it to the public record."}</p>
            <SealStub txHash={action.txHash} signer={signerName(session?.persona)} method={method === "passkey" ? "passkey" : "wallet"} signedAt={signedAt} currency={currency} sealing={sealing} />
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : null}
        {notice && !action ? (
          <p className="rounded-lg bg-waiting-wash px-3.5 py-3 text-[0.8125rem] text-pretty text-waiting" role="status" data-testid="sign-notice">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="flex gap-2 rounded-lg bg-blocked-wash px-3.5 py-3 text-[0.8125rem] text-pretty text-blocked" role="alert" data-testid="sign-error">
            <OctagonAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
        {needsPasskey ? (
          <p className="px-0.5 text-[0.8125rem] text-pretty text-ink-2" data-testid="sign-needs-passkey">
            To sign, you need a passkey: your fingerprint, face or phone PIN, like Touch ID. Ask your loan officer for a set-up code.
          </p>
        ) : null}

        {action ? null : (
          <DialogFooter className="gap-2 sm:items-center sm:justify-between">
            <div className="flex gap-2">
              {method === "passkey" && ethereum() ? (
                <Button variant="ghost" size="sm" onClick={() => setMethod("eip712")} disabled={Boolean(busy)}>
                  <Wallet /> Sign with a browser wallet (MetaMask) instead
                </Button>
              ) : null}
              {method === "eip712" ? (
                <Button variant="ghost" size="sm" onClick={() => setMethod("passkey")} disabled={Boolean(busy)}>
                  <Fingerprint /> Use a passkey instead
                </Button>
              ) : null}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              {needsPasskey ? (
                <Button onClick={startEnrolment} disabled={busy !== undefined || !passkeysSupported()}>
                  <KeyRound /> Create your passkey first
                </Button>
              ) : null}
              {method === "passkey" && hasPasskey && offerNewPasskey && !enrolling ? (
                <Button variant="secondary" onClick={startEnrolment} disabled={busy !== undefined || !passkeysSupported()}>
                  <KeyRound /> Create a new passkey
                </Button>
              ) : null}
              {method === "passkey" && hasPasskey ? (
                <SignButton ref={signButton} busy={busy === "sign"} onClick={signWithPasskey} disabled={signDisabled}>
                  Sign with passkey
                </SignButton>
              ) : null}
              {method === "eip712" ? (
                <SignButton icon={<Wallet aria-hidden />} busy={busy === "sign"} busyLabel="Check your wallet…" onClick={signWithMetaMask} disabled={signDisabled}>
                  Sign with MetaMask
                </SignButton>
              ) : null}
            </div>
          </DialogFooter>
        )}
        {req && check && !action ? <SignDetails request={req} check={check} currency={currency} /> : null}
      </DialogContent>
    </Dialog>
  );
}
