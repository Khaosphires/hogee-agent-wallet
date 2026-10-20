/**
 * One valid example per main schema, built from the Rina numbers (§26.2), plus a Singapore (Mei) example wherever a
 * schema carries a country, currency or persona (example-data/sg.ts). P2/P3 copy from these.
 * Hashes/addresses are deterministic fakes (see example-data/fake.ts); URLs use example.invalid.
 * `SCHEMA_EXAMPLES` pairs every example with its schema; core tests parse all of them.
 */
import type { z } from "zod";
import { ApiError } from "./api-error";
import { AutonomyStats, Balances } from "./balances";
import { ChatDataPart, ChatMessage } from "./chat";
import { CfoAgentAction, CfoInsight, CfoReport } from "./cfo";
import { ChatAction, JourneyFacts, JourneyState, SkillCall } from "./journey";
import { NeedsChecklist } from "./needs";
import { OrderTerms, OrderTermsInput, TermsPrefill } from "./orders";
import { CandidateCard, SupplierSearch, SupplierSearchBody, WebSearchAnswer, WebSearchQuery, WebSearchResult } from "./search";
import { CountryPack } from "./country-pack";
import {
  E1AttackRow,
  E1CleanRow,
  E2LabelRow,
  E2PromptRow,
  E5DocRow,
  HashVectors,
  SanctionsRow,
  SupplierEvalLabel,
} from "./datasets";
import { EscrowSchedule } from "./escrow";
import { BundleManifest, EvidenceBundle, EvidenceRow, EvidenceRunSummary } from "./evidence";
import { Exception, ExceptionCreate } from "./exception";
import { Invoice } from "./invoice";
import { Payment, SpendProposal, SpendProposalResult } from "./payment";
import { PlanDraft, PlanIntent, PlanManifest, PlanRecord } from "./plan";
import { Facility, Health, Session } from "./session";
import {
  ChainAction,
  DisplayModel,
  EnrolmentCode,
  PasskeyRegistrationOptions,
  PasskeyRegistrationResponse,
  PasskeyRegistrationResult,
  PendingFounderKey,
  SignatureRequestBody,
  SignatureRequestResponse,
  SignatureSubmitBody,
} from "./signing";
import { RankedSupplier, Shortlist, ShortlistSpec, Supplier, SupplierWithEvidence } from "./supplier";
import { TraceEvent } from "./trace";
import * as catalog from "./example-data/catalog";
import * as journey from "./example-data/journey";
import * as misc from "./example-data/misc";
import * as ops from "./example-data/ops";
import * as plan from "./example-data/plan";
import * as sg from "./example-data/sg";

export * from "./example-data/catalog";
export * from "./example-data/journey";
export * from "./example-data/misc";
export * from "./example-data/ops";
export * from "./example-data/plan";
export * from "./example-data/sg";
export { fakeAddress, fakeHex32, fakeUuidV7 } from "./example-data/fake";

export interface SchemaExample {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly value: unknown;
}

const ex = (name: string, schema: z.ZodType, value: unknown): SchemaExample => ({ name, schema, value });

export const SCHEMA_EXAMPLES: readonly SchemaExample[] = [
  ex("PlanIntent", PlanIntent, plan.examplePlanIntent),
  ex("PlanManifest", PlanManifest, plan.examplePlanManifest),
  ex("PlanManifest (baseline)", PlanManifest, plan.examplePlanBaseline),
  ex("PlanDraft", PlanDraft, plan.examplePlanDraft),
  ex("PlanRecord", PlanRecord, plan.examplePlanRecord),
  ex("CountryPack", CountryPack, catalog.exampleCountryPack),
  ex("CountryPack (SG)", CountryPack, sg.exampleCountryPackSG),
  ex("Supplier", Supplier, catalog.exampleSupplier),
  ex("SupplierWithEvidence", SupplierWithEvidence, catalog.exampleSupplierWithEvidence),
  ex("RankedSupplier", RankedSupplier, catalog.exampleRankedSupplier),
  ex("Shortlist", Shortlist, catalog.exampleShortlist),
  ex("Shortlist FAILED", Shortlist, catalog.exampleFailedShortlist),
  ex("ShortlistSpec", ShortlistSpec, catalog.exampleShortlistSpec),
  ex("Invoice", Invoice, ops.exampleInvoice),
  ex("Payment", Payment, ops.examplePayment),
  ex("Payment OWNER_SPEND", Payment, ops.exampleOwnerSpendPayment),
  ex("Payment WITHDRAW_RESERVE", Payment, ops.exampleWithdrawReservePayment),
  ex("SpendProposal (pacing)", SpendProposal, ops.exampleSpendProposal),
  ex("SpendProposal (invoice)", SpendProposal, ops.exampleInvoiceSpendProposal),
  ex("SpendProposalResult", SpendProposalResult, ops.exampleSpendProposalResult),
  ...ops.exampleExceptions.map((e) => ex(`Exception ${e.kind}`, Exception, e)),
  ex("ExceptionCreate", ExceptionCreate, ops.exampleExceptionCreate),
  ex("TraceEvent", TraceEvent, ops.exampleTraceEvent),
  ex("Balances", Balances, ops.exampleBalances),
  ex("AutonomyStats", AutonomyStats, ops.exampleAutonomyStats),
  ex("EscrowSchedule", EscrowSchedule, ops.exampleEscrowSchedule),
  ex("Session", Session, misc.exampleSession),
  ex("Session (Mei, SG)", Session, sg.exampleSessionMei),
  ex("Health", Health, misc.exampleHealth),
  ex("Facility", Facility, misc.exampleFacility),
  ex("Facility (Mei, SG)", Facility, sg.exampleFacilityMei),
  ex("DisplayModel", DisplayModel, misc.exampleDisplayModel),
  ex("DisplayModel SupplierApproval", DisplayModel, misc.exampleDisplayModelSupplierApproval),
  ex("SignatureRequestBody", SignatureRequestBody, misc.exampleSignatureRequestBody),
  ex("SignatureRequestResponse", SignatureRequestResponse, misc.exampleSignatureRequestResponse),
  ex("SignatureSubmitBody (passkey)", SignatureSubmitBody, misc.exampleSignatureSubmitPasskey),
  ex("SignatureSubmitBody (ecdsa)", SignatureSubmitBody, misc.exampleSignatureSubmitEcdsa),
  ex("ChainAction", ChainAction, misc.exampleChainAction),
  ex("PasskeyRegistrationOptions", PasskeyRegistrationOptions, misc.examplePasskeyRegistrationOptions),
  ex("PasskeyRegistrationResponse", PasskeyRegistrationResponse, misc.examplePasskeyRegistrationResponse),
  ex("PasskeyRegistrationResult", PasskeyRegistrationResult, misc.examplePasskeyRegistrationResult),
  ex("EnrolmentCode", EnrolmentCode, misc.exampleEnrolmentCode),
  ex("PendingFounderKey", PendingFounderKey, misc.examplePendingFounderKey),
  ex("EvidenceRow", EvidenceRow, misc.exampleEvidenceRow),
  ex("BundleManifest", BundleManifest, misc.exampleBundleManifest),
  ex("EvidenceRunSummary", EvidenceRunSummary, misc.exampleEvidenceRunSummary),
  ex("EvidenceBundle", EvidenceBundle, misc.exampleEvidenceBundle),
  ex("ApiError", ApiError, misc.exampleApiError),
  ...misc.exampleChatDataParts.map((p) => ex(`ChatDataPart ${p.type}`, ChatDataPart, p)),
  ...misc.exampleChatMessages.map((m) => ex(`ChatMessage ${m.id}`, ChatMessage, m)),
  ex("E1AttackRow", E1AttackRow, misc.exampleE1AttackRow),
  ex("E1CleanRow", E1CleanRow, misc.exampleE1CleanRow),
  ex("E2PromptRow", E2PromptRow, misc.exampleE2PromptRow),
  ex("E2PromptRow (SG)", E2PromptRow, sg.exampleE2PromptRowSG),
  ex("E2LabelRow", E2LabelRow, misc.exampleE2LabelRow),
  ex("E2LabelRow (SG)", E2LabelRow, sg.exampleE2LabelRowSG),
  ex("E5DocRow", E5DocRow, misc.exampleE5DocRow),
  ex("E5DocRow (SG)", E5DocRow, sg.exampleE5DocRowSG),
  ex("SupplierEvalLabel", SupplierEvalLabel, misc.exampleSupplierEvalLabel),
  ex("HashVectors (shape only)", HashVectors, misc.exampleHashVectors),
  ex("SanctionsRow", SanctionsRow, misc.exampleSanctionsRow),
  // VISION-DECISIONS §3/§4 (chat-first, Mei / SGD).
  ...journey.exampleChatActions.map((a) => ex(`ChatAction ${a.type}`, ChatAction, a)),
  ex("SkillCall", SkillCall, journey.exampleSkillCall),
  ex("JourneyFacts", JourneyFacts, journey.exampleJourneyFacts),
  ex("JourneyState", JourneyState, journey.exampleJourneyState),
  ex("WebSearchQuery", WebSearchQuery, journey.exampleWebSearchQuery),
  ex("WebSearchResult", WebSearchResult, journey.exampleWebSearchResult),
  ex("WebSearchAnswer", WebSearchAnswer, journey.exampleWebSearchAnswer),
  ex("CandidateCard (web)", CandidateCard, journey.exampleWebCandidate),
  ex("CandidateCard (catalog)", CandidateCard, journey.exampleCatalogCandidate),
  ex("SupplierSearch", SupplierSearch, journey.exampleSupplierSearch),
  ex("SupplierSearch FAILED", SupplierSearch, journey.exampleFailedSupplierSearch),
  ex("SupplierSearchBody", SupplierSearchBody, journey.exampleSupplierSearchBody),
  ex("OrderTermsInput", OrderTermsInput, journey.exampleOrderTermsInput),
  ex("OrderTerms", OrderTerms, journey.exampleOrderTerms),
  ex("TermsPrefill", TermsPrefill, journey.exampleTermsPrefill),
  ex("CfoInsight", CfoInsight, journey.exampleCfoInsight),
  ex("CfoAgentAction", CfoAgentAction, journey.exampleCfoAgentAction),
  ex("CfoReport", CfoReport, journey.exampleCfoReport),
  ex("NeedsChecklist", NeedsChecklist, journey.exampleNeedsChecklist),
  ...journey.exampleJourneyDataParts.map((p) => ex(`ChatDataPart ${p.type}`, ChatDataPart, p)),
  ...journey.exampleJourneyMessages.map((m) => ex(`ChatMessage ${m.id}`, ChatMessage, m)),
];
