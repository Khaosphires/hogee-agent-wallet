/**
 * The tenant rows of a request. Every query in the API is scoped by the session's facility (server config, never the
 * request), so another tenant's ids simply do not exist for this session (T31).
 */
import { CountryCode } from "@hogee/core";
import type { Scope } from "../context";
import { fail } from "../http/problem";
import { one, type Q } from "./sql";

export interface FacilityRow {
  facility_id: string;
  cap_minor: string;
  currency: string;
  reserve_floor_bps: number;
  lender_address: string;
  deployment_id: string;
  chain_id: number;
  opened_tx: string | null;
}

export interface FounderRow {
  id: string;
  country: CountryCode;
  residency: "citizen" | "pr" | "foreigner";
  passkey_credential_id: string | null;
  qx: string | null;
  qy: string | null;
  wallet_address: string | null;
  key_status: "PENDING_LENDER" | "REGISTERED";
}

export async function facilityRow(q: Q, scope: Scope): Promise<FacilityRow | undefined> {
  return one<FacilityRow>(
    q,
    `select facility_id, cap_minor::text as cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id, opened_tx
       from facilities where facility_id = $1`,
    [scope.facilityId],
  );
}

/** The facility, or CONFLICT when the loan officer has not opened it yet (nothing else can happen before step 0). */
export async function requireFacility(q: Q, scope: Scope): Promise<FacilityRow> {
  const f = await facilityRow(q, scope);
  if (!f) throw fail("CONFLICT", "The loan officer has not opened the facility yet");
  return f;
}

/** The founder row; a country outside COUNTRY_CODES is refused at runtime (the type alone proves nothing about a row). */
export async function founderRow(q: Q, scope: Scope): Promise<FounderRow | undefined> {
  const f = await one<FounderRow>(
    q,
    `select id, country, residency, passkey_credential_id, qx, qy, wallet_address, key_status from founders where facility_id = $1 and id = $2`,
    [scope.facilityId, scope.founderId],
  );
  if (f && !CountryCode.safeParse(f.country).success) throw fail("UPSTREAM", "The founder row names a country this server does not support");
  return f;
}
