/**
 * Per-kind signing (§8.7): what the founder signs (built from server state only, never from the request beyond the
 * refId) and what is relayed after the signature verifies. `prepare` refuses anything not signable; `finalize`
 * re-reads the state at submit, returns the exact call the relayer will send (simulated first) and the rows to write
 * in the transaction that consumes the request.
 */
import type { ChainAction, DisplayModel, SignatureKind } from "@hogee/core";
import type { HogeeCall, OnchainSig } from "../../chain-lib";
import type { ApiDeps, Scope } from "../../context";
import type { ContractKey } from "../../deployment";
import type { PoolClient } from "pg";
import type { TypedMessage } from "./typed";

export type DisplayRow = DisplayModel["rows"][number];

export interface PreparedSign {
  readonly contract: ContractKey;
  /** Struct fields except deploymentId, nonce and expiry (added by buildTyped). */
  readonly fields: TypedMessage;
  readonly title: string;
  readonly rows: readonly DisplayRow[];
}

export interface StoredRequest {
  readonly id: string;
  readonly kind: SignatureKind;
  readonly ref_id: string;
  readonly method: "passkey" | "eip712";
  readonly typed_data_json: { readonly message: TypedMessage };
  readonly digest: string;
  readonly expires_at: string;
  readonly status: "PENDING" | "SUBMITTED" | "REJECTED" | "EXPIRED";
}

export interface Finalized {
  /**
   * The call the relayer will send; simulated from the relayer address before anything is written. Absent only when
   * the call needs another party's signature first (a LoosenRequest awaits the lender's co-signature).
   */
  readonly call?: HogeeCall;
  /** Writes the product rows and the unsigned chain action, inside the transaction that consumes the request. */
  commit(q: PoolClient): Promise<ChainAction>;
}

export interface SignKind {
  prepare(deps: ApiDeps, scope: Scope, refId: string): Promise<PreparedSign>;
  finalize(deps: ApiDeps, scope: Scope, req: StoredRequest, sig: OnchainSig): Promise<Finalized>;
}

export const row = (label: string, value: string, effect: DisplayRow["effect"] = "neutral"): DisplayRow => ({ label, value: value.slice(0, 500), effect });

/** Unix seconds → YYYY-MM-DD (UTC) for the panel. */
export const day = (unix: string | bigint): string => new Date(Number(unix) * 1000).toISOString().slice(0, 10);
