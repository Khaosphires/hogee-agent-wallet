CREATE TYPE "public"."chain_action_state" AS ENUM('PENDING', 'BROADCAST', 'INCLUDED', 'FINALIZED', 'REVERTED');--> statement-breakpoint
CREATE TYPE "public"."chat_role" AS ENUM('system', 'user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."country_code" AS ENUM('MY', 'ID');--> statement-breakpoint
CREATE TYPE "public"."evidence_run_status" AS ENUM('PENDING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."evidence_tier" AS ENUM('tier1', 'tier2', 'tier3');--> statement-breakpoint
CREATE TYPE "public"."exception_kind" AS ENUM('RAISE_CAP', 'ADD_PAYEE', 'EXTEND_EXPIRY', 'MOVE_POCKETS', 'UNPAUSE', 'WITHDRAW_RESERVE', 'RELEASE_ESCROW_BALANCE', 'RELEASE_STAGE', 'REPLAN', 'POLICY_ESCALATION');--> statement-breakpoint
CREATE TYPE "public"."exception_status" AS ENUM('OPEN', 'FOUNDER_SIGNED', 'APPROVED', 'QUEUED', 'EXECUTABLE', 'EXECUTED', 'DENIED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."founder_key_status" AS ENUM('PENDING_LENDER', 'REGISTERED');--> statement-breakpoint
CREATE TYPE "public"."line_key" AS ENUM('SUPPLIER', 'PACKAGING', 'LOGISTICS', 'ADS', 'PLATFORM_FEES', 'LICENSING', 'CONTINGENCY');--> statement-breakpoint
CREATE TYPE "public"."llm_role" AS ENUM('planner', 'reader', 'explainer', 'judge', 'classifier');--> statement-breakpoint
CREATE TYPE "public"."memory_source" AS ENUM('USER_TURN', 'ORACLE_FACT');--> statement-breakpoint
CREATE TYPE "public"."payee_kind" AS ENUM('supplier', 'platform');--> statement-breakpoint
CREATE TYPE "public"."payee_status" AS ENUM('PENDING', 'COOLING', 'BOUND', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('SPEND', 'FUND_MILESTONE', 'RELEASE_MILESTONE', 'OWNER_SPEND', 'WITHDRAW_RESERVE');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('PROPOSED', 'POLICY_DENIED', 'POLICY_OK', 'SIGNED', 'BROADCAST', 'INCLUDED', 'FINALIZED', 'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED', 'REVERTED', 'DROPPED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('NONE', 'REQUESTED', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('PENDING_SIGNATURE', 'SUBMITTED', 'COMMITTED', 'SUPERSEDED', 'REVERTED');--> statement-breakpoint
CREATE TYPE "public"."policy_verdict" AS ENUM('AUTO', 'NEEDS_FOUNDER', 'NEEDS_OFFICER', 'DENY');--> statement-breakpoint
CREATE TYPE "public"."residency" AS ENUM('citizen', 'pr', 'foreigner');--> statement-breakpoint
CREATE TYPE "public"."shortlist_status" AS ENUM('PENDING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."signature_kind" AS ENUM('PlanApproval', 'SupplierApproval', 'MilestoneRelease', 'LoosenRequest', 'StageRelease', 'OwnerSpend');--> statement-breakpoint
CREATE TYPE "public"."signature_method" AS ENUM('passkey', 'eip712');--> statement-breakpoint
CREATE TYPE "public"."signature_request_status" AS ENUM('PENDING', 'SUBMITTED', 'REJECTED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('live', 'mock');--> statement-breakpoint
CREATE TYPE "public"."trace_actor" AS ENUM('planner', 'reader', 'policy', 'txbuilder', 'executor', 'worker', 'founder', 'officer', 'oracle', 'reconciler');--> statement-breakpoint
CREATE TYPE "public"."trace_kind" AS ENUM('LLM_CALL', 'TOOL_CALL', 'PROPOSAL', 'POLICY_VERDICT', 'TX', 'PAYOUT', 'SIGNATURE', 'EXCEPTION', 'DENIAL', 'ALERT');--> statement-breakpoint
CREATE TABLE "facilities" (
	"facility_id" text PRIMARY KEY NOT NULL,
	"cap_minor" numeric(39, 0) NOT NULL,
	"currency" text NOT NULL,
	"reserve_floor_bps" integer NOT NULL,
	"lender_address" text NOT NULL,
	"deployment_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"opened_tx" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facilities_cap_minor_nonneg" CHECK ("facilities"."cap_minor" >= 0),
	CONSTRAINT "facilities_cap_minor_uint128" CHECK ("facilities"."cap_minor" <= 340282366920938463463374607431768211455),
	CONSTRAINT "facilities_lender_address_address" CHECK ("facilities"."lender_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "facilities_opened_tx_hex32" CHECK ("facilities"."opened_tx" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "facilities_currency_iso4217" CHECK ("facilities"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "facilities_reserve_floor_bps_range" CHECK ("facilities"."reserve_floor_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "founders" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"country" "country_code" NOT NULL,
	"residency" "residency" NOT NULL,
	"passkey_credential_id" text,
	"qx" text,
	"qy" text,
	"wallet_address" text,
	"key_status" "founder_key_status" DEFAULT 'PENDING_LENDER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "founders_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "founders_qx_hex32" CHECK ("founders"."qx" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "founders_qy_hex32" CHECK ("founders"."qy" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "founders_wallet_address_address" CHECK ("founders"."wallet_address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" "chat_role" NOT NULL,
	"parts_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_pk" PRIMARY KEY("facility_id","id")
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid NOT NULL,
	"facility_id" text NOT NULL,
	"founder_id" text,
	"intent_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_sessions_pk" PRIMARY KEY("facility_id","id")
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"session_id" uuid,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" "memory_source" NOT NULL,
	"source_ref" text NOT NULL,
	"hmac" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entries_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "memory_entries_hmac_hex32" CHECK ("memory_entries"."hmac" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "plan_drafts" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"session_id" uuid,
	"source_draft_id" text,
	"country_code" "country_code" NOT NULL,
	"intent_json" jsonb NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"baseline_json" jsonb NOT NULL,
	"diff_json" jsonb NOT NULL,
	"blast_radius_minor" numeric(39, 0) NOT NULL,
	"constitution_report_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_drafts_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "plan_drafts_blast_radius_minor_nonneg" CHECK ("plan_drafts"."blast_radius_minor" >= 0),
	CONSTRAINT "plan_drafts_blast_radius_minor_uint128" CHECK ("plan_drafts"."blast_radius_minor" <= 340282366920938463463374607431768211455)
);
--> statement-breakpoint
CREATE TABLE "plan_lines" (
	"plan_id" text NOT NULL,
	"facility_id" text NOT NULL,
	"line_key" "line_key" NOT NULL,
	"line_id" text NOT NULL,
	"purpose" text NOT NULL,
	"amount_minor" numeric(39, 0) NOT NULL,
	"per_tx_cap_minor" numeric(39, 0) NOT NULL,
	"window_cap_minor" numeric(39, 0) NOT NULL,
	"window_seconds" integer NOT NULL,
	"valid_until" bigint NOT NULL,
	"escrow_only" boolean DEFAULT false NOT NULL,
	"pacing_amount_minor" numeric(39, 0),
	"payee_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "plan_lines_pk" PRIMARY KEY("facility_id","plan_id","line_key"),
	CONSTRAINT "plan_lines_line_id_hex32" CHECK ("plan_lines"."line_id" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "plan_lines_amount_minor_nonneg" CHECK ("plan_lines"."amount_minor" >= 0),
	CONSTRAINT "plan_lines_amount_minor_uint128" CHECK ("plan_lines"."amount_minor" <= 340282366920938463463374607431768211455),
	CONSTRAINT "plan_lines_per_tx_cap_minor_nonneg" CHECK ("plan_lines"."per_tx_cap_minor" >= 0),
	CONSTRAINT "plan_lines_per_tx_cap_minor_uint128" CHECK ("plan_lines"."per_tx_cap_minor" <= 340282366920938463463374607431768211455),
	CONSTRAINT "plan_lines_window_cap_minor_nonneg" CHECK ("plan_lines"."window_cap_minor" >= 0),
	CONSTRAINT "plan_lines_window_cap_minor_uint128" CHECK ("plan_lines"."window_cap_minor" <= 340282366920938463463374607431768211455),
	CONSTRAINT "plan_lines_pacing_amount_minor_nonneg" CHECK ("plan_lines"."pacing_amount_minor" >= 0),
	CONSTRAINT "plan_lines_pacing_amount_minor_uint128" CHECK ("plan_lines"."pacing_amount_minor" <= 340282366920938463463374607431768211455)
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"draft_id" text,
	"plan_id" text NOT NULL,
	"version" integer NOT NULL,
	"prev_plan_hash" text NOT NULL,
	"plan_hash" text NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"country_pack_hash" text NOT NULL,
	"status" "plan_status" DEFAULT 'PENDING_SIGNATURE' NOT NULL,
	"signed_at" timestamp with time zone,
	"tx_hash" text,
	"revert_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "plans_prev_plan_hash_hex32" CHECK ("plans"."prev_plan_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "plans_plan_hash_hex32" CHECK ("plans"."plan_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "plans_country_pack_hash_hex32" CHECK ("plans"."country_pack_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "plans_tx_hash_hex32" CHECK ("plans"."tx_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "escrow_milestones" (
	"order_id" text NOT NULL,
	"idx" integer NOT NULL,
	"facility_id" text NOT NULL,
	"amount_minor" numeric(39, 0) NOT NULL,
	"funded_minor" numeric(39, 0) DEFAULT '0' NOT NULL,
	"released_minor" numeric(39, 0) DEFAULT '0' NOT NULL,
	"auto_release" boolean NOT NULL,
	"evidence_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escrow_milestones_pk" PRIMARY KEY("facility_id","order_id","idx"),
	CONSTRAINT "escrow_milestones_evidence_hash_hex32" CHECK ("escrow_milestones"."evidence_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "escrow_milestones_amount_minor_nonneg" CHECK ("escrow_milestones"."amount_minor" >= 0),
	CONSTRAINT "escrow_milestones_amount_minor_uint128" CHECK ("escrow_milestones"."amount_minor" <= 340282366920938463463374607431768211455),
	CONSTRAINT "escrow_milestones_funded_minor_nonneg" CHECK ("escrow_milestones"."funded_minor" >= 0),
	CONSTRAINT "escrow_milestones_funded_minor_uint128" CHECK ("escrow_milestones"."funded_minor" <= 340282366920938463463374607431768211455),
	CONSTRAINT "escrow_milestones_released_minor_nonneg" CHECK ("escrow_milestones"."released_minor" >= 0),
	CONSTRAINT "escrow_milestones_released_minor_uint128" CHECK ("escrow_milestones"."released_minor" <= 340282366920938463463374607431768211455)
);
--> statement-breakpoint
CREATE TABLE "escrow_orders" (
	"order_id" text NOT NULL,
	"facility_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"payee_id" text NOT NULL,
	"schedule_hash" text NOT NULL,
	"total_minor" numeric(39, 0) NOT NULL,
	"quote_hash" text,
	"shortlist_hash" text,
	"chosen_index" integer,
	"inspection_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "escrow_orders_pk" PRIMARY KEY("facility_id","order_id"),
	CONSTRAINT "escrow_orders_schedule_hash_hex32" CHECK ("escrow_orders"."schedule_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "escrow_orders_quote_hash_hex32" CHECK ("escrow_orders"."quote_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "escrow_orders_shortlist_hash_hex32" CHECK ("escrow_orders"."shortlist_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "escrow_orders_total_minor_nonneg" CHECK ("escrow_orders"."total_minor" >= 0),
	CONSTRAINT "escrow_orders_total_minor_uint128" CHECK ("escrow_orders"."total_minor" <= 340282366920938463463374607431768211455)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"payee_id" text NOT NULL,
	"order_id" text,
	"milestone_idx" integer,
	"amount_minor" numeric(39, 0) NOT NULL,
	"invoice_hash" text NOT NULL,
	"extracted_fields_json" jsonb NOT NULL,
	"taint" jsonb NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "invoices_invoice_hash_hex32" CHECK ("invoices"."invoice_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "invoices_amount_minor_nonneg" CHECK ("invoices"."amount_minor" >= 0),
	CONSTRAINT "invoices_amount_minor_uint128" CHECK ("invoices"."amount_minor" <= 340282366920938463463374607431768211455),
	CONSTRAINT "invoices_taint_shape" CHECK ("invoices"."taint"->>'trust' IN ('trusted', 'untrusted') AND "invoices"."taint"->>'sensitivity' IN ('public', 'private'))
);
--> statement-breakpoint
CREATE TABLE "payees" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"kind" "payee_kind" NOT NULL,
	"display_name" text NOT NULL,
	"supplier_id" text,
	"xendit_account_ref" text,
	"payout_account_hash" text NOT NULL,
	"bound_line_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"approval_sig" jsonb,
	"cooling_until" bigint,
	"status" "payee_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payees_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "payees_supplier_kind" CHECK ("payees"."kind" <> 'supplier' OR "payees"."supplier_id" IS NOT NULL),
	CONSTRAINT "payees_payout_account_hash_hex32" CHECK ("payees"."payout_account_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "shortlists" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"status" "shortlist_status" DEFAULT 'PENDING' NOT NULL,
	"spec_json" jsonb NOT NULL,
	"result_json" jsonb,
	"shortlist_hash" text,
	"weights_version" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shortlists_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "shortlists_shortlist_hash_hex32" CHECK ("shortlists"."shortlist_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "supplier_evidence" (
	"facility_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"criterion" text NOT NULL,
	"tier" "evidence_tier" NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_url" text,
	"snippet_hash" text,
	"value" jsonb,
	"taint" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_evidence_pk" PRIMARY KEY("facility_id","evidence_id"),
	CONSTRAINT "supplier_evidence_snippet_hash_hex32" CHECK ("supplier_evidence"."snippet_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "supplier_evidence_taint_shape" CHECK ("supplier_evidence"."taint"->>'trust' IN ('trusted', 'untrusted') AND "supplier_evidence"."taint"->>'sensitivity' IN ('public', 'private'))
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"facility_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"display_name" text NOT NULL,
	"country" text NOT NULL,
	"record_json" jsonb NOT NULL,
	"check_results_json" jsonb,
	"evidence_tier" "evidence_tier" NOT NULL,
	"source_type" "source_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_pk" PRIMARY KEY("facility_id","supplier_id"),
	CONSTRAINT "suppliers_country_iso2" CHECK ("suppliers"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "chain_actions" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text,
	"state" "chain_action_state" DEFAULT 'PENDING' NOT NULL,
	"signer_address" text,
	"chain_id" integer,
	"raw_signed_tx" text,
	"nonce" bigint,
	"tx_hash" text,
	"block" bigint,
	"revert_reason" text,
	"request_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_actions_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "chain_actions_tx_hash_hex32" CHECK ("chain_actions"."tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "chain_actions_signer_address_address" CHECK ("chain_actions"."signer_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "chain_actions_raw_signed_tx_hex" CHECK ("chain_actions"."raw_signed_tx" ~ '^0x([0-9a-f]{2})+$'),
	CONSTRAINT "chain_actions_signed_tx_atomic" CHECK (("chain_actions"."raw_signed_tx" IS NULL) = ("chain_actions"."nonce" IS NULL) AND ("chain_actions"."raw_signed_tx" IS NULL) = ("chain_actions"."signer_address" IS NULL) AND ("chain_actions"."raw_signed_tx" IS NULL) = ("chain_actions"."chain_id" IS NULL)),
	CONSTRAINT "chain_actions_signed_state_has_tx" CHECK ("chain_actions"."state" IN ('PENDING') OR "chain_actions"."raw_signed_tx" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "denials" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"proposal_json" jsonb NOT NULL,
	"proposal_hash" text NOT NULL,
	"reason" text NOT NULL,
	"reason_code" text NOT NULL,
	"recorded_tx" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "denials_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "denials_proposal_hash_hex32" CHECK ("denials"."proposal_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "denials_recorded_tx_hex32" CHECK ("denials"."recorded_tx" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "log_checkpoints" (
	"contract" text NOT NULL,
	"chain_id" integer NOT NULL,
	"last_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "log_checkpoints_pk" PRIMARY KEY("contract","chain_id"),
	CONSTRAINT "log_checkpoints_contract_address" CHECK ("log_checkpoints"."contract" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "log_checkpoints_last_block_nonneg" CHECK ("log_checkpoints"."last_block" >= 0)
);
--> statement-breakpoint
CREATE TABLE "nonces" (
	"signer_address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"next_nonce" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nonces_pk" PRIMARY KEY("signer_address","chain_id"),
	CONSTRAINT "nonces_signer_address_address" CHECK ("nonces"."signer_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "nonces_next_nonce_nonneg" CHECK ("nonces"."next_nonce" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"intent_id" text NOT NULL,
	"line_key" "line_key",
	"line_id" text,
	"payee_id" text NOT NULL,
	"order_id" text,
	"milestone_idx" integer,
	"amount_minor" numeric(39, 0) NOT NULL,
	"invoice_hash" text NOT NULL,
	"plan_version" integer NOT NULL,
	"state" "payment_state" DEFAULT 'PROPOSED' NOT NULL,
	"signer_address" text,
	"chain_id" integer,
	"raw_signed_tx" text,
	"nonce" bigint,
	"tx_hash" text,
	"superseded_tx_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"nonce_consumed_by_tx_hash" text,
	"block" bigint,
	"revert_reason" text,
	"settlement_id" text,
	"payout_id" text,
	"payout_attempt" integer DEFAULT 0 NOT NULL,
	"payout_status" "payout_status" DEFAULT 'NONE' NOT NULL,
	"payout_failure_code" text,
	"decision_id" uuid,
	"rationale_hash" text,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "payments_decision_iff_agent_kind" CHECK (CASE WHEN "payments"."kind" IN ('OWNER_SPEND', 'WITHDRAW_RESERVE') THEN "payments"."decision_id" IS NULL AND "payments"."rationale_hash" IS NULL ELSE "payments"."decision_id" IS NOT NULL AND "payments"."rationale_hash" IS NOT NULL END),
	CONSTRAINT "payments_line_iff_not_reserve" CHECK (CASE WHEN "payments"."kind" = 'WITHDRAW_RESERVE' THEN "payments"."line_key" IS NULL AND "payments"."line_id" IS NULL ELSE "payments"."line_key" IS NOT NULL AND "payments"."line_id" IS NOT NULL END),
	CONSTRAINT "payments_withdraw_reserve_zero_invoice" CHECK ("payments"."kind" <> 'WITHDRAW_RESERVE' OR "payments"."invoice_hash" = '0x0000000000000000000000000000000000000000000000000000000000000000'),
	CONSTRAINT "payments_milestone_ref" CHECK ("payments"."kind" NOT IN ('FUND_MILESTONE', 'RELEASE_MILESTONE') OR ("payments"."order_id" IS NOT NULL AND "payments"."milestone_idx" IS NOT NULL)),
	CONSTRAINT "payments_intent_id_hex32" CHECK ("payments"."intent_id" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "payments_line_id_hex32" CHECK ("payments"."line_id" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "payments_invoice_hash_hex32" CHECK ("payments"."invoice_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "payments_tx_hash_hex32" CHECK ("payments"."tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "payments_nonce_consumed_by_tx_hash_hex32" CHECK ("payments"."nonce_consumed_by_tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "payments_settlement_id_hex32" CHECK ("payments"."settlement_id" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "payments_rationale_hash_hex32" CHECK ("payments"."rationale_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "payments_superseded_tx_hashes_hex32" CHECK (array_position("payments"."superseded_tx_hashes", NULL) IS NULL AND array_to_string("payments"."superseded_tx_hashes", ',') ~ '^(0x[0-9a-f]{64}(,0x[0-9a-f]{64})*)?$'),
	CONSTRAINT "payments_signer_address_address" CHECK ("payments"."signer_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "payments_amount_minor_nonneg" CHECK ("payments"."amount_minor" >= 0),
	CONSTRAINT "payments_amount_minor_uint128" CHECK ("payments"."amount_minor" <= 340282366920938463463374607431768211455),
	CONSTRAINT "payments_raw_signed_tx_hex" CHECK ("payments"."raw_signed_tx" ~ '^0x([0-9a-f]{2})+$'),
	CONSTRAINT "payments_signed_tx_atomic" CHECK (("payments"."raw_signed_tx" IS NULL) = ("payments"."nonce" IS NULL) AND ("payments"."raw_signed_tx" IS NULL) = ("payments"."signer_address" IS NULL) AND ("payments"."raw_signed_tx" IS NULL) = ("payments"."chain_id" IS NULL)),
	CONSTRAINT "payments_signed_state_has_tx" CHECK ("payments"."state" IN ('PROPOSED', 'POLICY_DENIED', 'POLICY_OK') OR "payments"."raw_signed_tx" IS NOT NULL),
	CONSTRAINT "payments_policy_denied_unsigned" CHECK ("payments"."state" <> 'POLICY_DENIED' OR "payments"."raw_signed_tx" IS NULL),
	CONSTRAINT "payments_cancelled_iff_nonce_consumed" CHECK (("payments"."state" = 'CANCELLED') = ("payments"."nonce_consumed_by_tx_hash" IS NOT NULL)),
	CONSTRAINT "payments_nonce_consumed_by_foreign_tx" CHECK ("payments"."nonce_consumed_by_tx_hash" IS NULL OR ("payments"."tx_hash" IS NOT NULL AND "payments"."nonce_consumed_by_tx_hash" <> "payments"."tx_hash" AND array_position("payments"."superseded_tx_hashes", "payments"."nonce_consumed_by_tx_hash") IS NULL)),
	CONSTRAINT "payments_reverted_has_receipt" CHECK ("payments"."state" <> 'REVERTED' OR ("payments"."block" IS NOT NULL AND "payments"."tx_hash" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"stripe_event_id" text NOT NULL,
	"sale_id_hash" text NOT NULL,
	"amount_bucket" numeric(39, 0) NOT NULL,
	"tx_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "sales_sale_id_hash_hex32" CHECK ("sales"."sale_id_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "sales_tx_hash_hex32" CHECK ("sales"."tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "sales_amount_bucket_nonneg" CHECK ("sales"."amount_bucket" >= 0),
	CONSTRAINT "sales_amount_bucket_uint128" CHECK ("sales"."amount_bucket" <= 340282366920938463463374607431768211455)
);
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"kind" "exception_kind" NOT NULL,
	"title" text NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text,
	"requested_by" text NOT NULL,
	"requires_founder" boolean NOT NULL,
	"requires_lender" boolean NOT NULL,
	"status" "exception_status" DEFAULT 'OPEN' NOT NULL,
	"founder_sig" jsonb,
	"lender_sig" jsonb,
	"loosen_id" text,
	"queued_at" timestamp with time zone,
	"executable_at" bigint,
	"queued_tx" text,
	"executed_tx" text,
	"blast_radius_minor" numeric(39, 0) DEFAULT '0' NOT NULL,
	"decision_reason" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exceptions_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "exceptions_queued_tx_hex32" CHECK ("exceptions"."queued_tx" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "exceptions_executed_tx_hex32" CHECK ("exceptions"."executed_tx" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "exceptions_blast_radius_minor_nonneg" CHECK ("exceptions"."blast_radius_minor" >= 0),
	CONSTRAINT "exceptions_blast_radius_minor_uint128" CHECK ("exceptions"."blast_radius_minor" <= 340282366920938463463374607431768211455)
);
--> statement-breakpoint
CREATE TABLE "signature_requests" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"kind" "signature_kind" NOT NULL,
	"ref_id" text NOT NULL,
	"method" "signature_method" NOT NULL,
	"typed_data_json" jsonb NOT NULL,
	"digest" text NOT NULL,
	"challenge_b64url" text NOT NULL,
	"display_model_json" jsonb NOT NULL,
	"nonce" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"status" "signature_request_status" DEFAULT 'PENDING' NOT NULL,
	"signature_json" jsonb,
	"chain_action_id" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signature_requests_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "signature_requests_digest_hex32" CHECK ("signature_requests"."digest" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "evidence_runs" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"status" "evidence_run_status" DEFAULT 'PENDING' NOT NULL,
	"git_commit" text,
	"manifest_json" jsonb,
	"row_count" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "evidence_runs_pk" PRIMARY KEY("facility_id","id")
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"trace_id" text,
	"role" "llm_role" NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"params_json" jsonb NOT NULL,
	"prompt_hash" text NOT NULL,
	"response_hash" text,
	"redaction_report" jsonb NOT NULL,
	"latency_ms" integer,
	"tokens" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_calls_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "llm_calls_prompt_hash_hex32" CHECK ("llm_calls"."prompt_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "llm_calls_response_hash_hex32" CHECK ("llm_calls"."response_hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"trace_id" text NOT NULL,
	"seq" integer NOT NULL,
	"facility_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" "trace_actor" NOT NULL,
	"kind" "trace_kind" NOT NULL,
	"summary" text NOT NULL,
	"policy_verdict" "policy_verdict",
	"reason_code" text,
	"plan_version" integer,
	"payment_id" text,
	"invoice_hash" text,
	"decision_id" uuid,
	"tx_hash" text,
	"payout_id" text,
	"exception_id" text,
	"llm_call_id" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "traces_pk" PRIMARY KEY("facility_id","trace_id","seq"),
	CONSTRAINT "traces_invoice_hash_hex32" CHECK ("traces"."invoice_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "traces_tx_hash_hex32" CHECK ("traces"."tx_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "traces_prev_hash_hex32" CHECK ("traces"."prev_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "traces_hash_hex32" CHECK ("traces"."hash" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "founders" ADD CONSTRAINT "founders_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_fk" FOREIGN KEY ("facility_id","session_id") REFERENCES "public"."chat_sessions"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_founder_fk" FOREIGN KEY ("facility_id","founder_id") REFERENCES "public"."founders"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_session_fk" FOREIGN KEY ("facility_id","session_id") REFERENCES "public"."chat_sessions"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_drafts" ADD CONSTRAINT "plan_drafts_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_drafts" ADD CONSTRAINT "plan_drafts_session_fk" FOREIGN KEY ("facility_id","session_id") REFERENCES "public"."chat_sessions"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_lines" ADD CONSTRAINT "plan_lines_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_lines" ADD CONSTRAINT "plan_lines_plan_fk" FOREIGN KEY ("facility_id","plan_id") REFERENCES "public"."plans"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_draft_fk" FOREIGN KEY ("facility_id","draft_id") REFERENCES "public"."plan_drafts"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_milestones" ADD CONSTRAINT "escrow_milestones_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_milestones" ADD CONSTRAINT "escrow_milestones_order_fk" FOREIGN KEY ("facility_id","order_id") REFERENCES "public"."escrow_orders"("facility_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_orders" ADD CONSTRAINT "escrow_orders_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_orders" ADD CONSTRAINT "escrow_orders_supplier_fk" FOREIGN KEY ("facility_id","supplier_id") REFERENCES "public"."suppliers"("facility_id","supplier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_orders" ADD CONSTRAINT "escrow_orders_payee_fk" FOREIGN KEY ("facility_id","payee_id") REFERENCES "public"."payees"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payee_fk" FOREIGN KEY ("facility_id","payee_id") REFERENCES "public"."payees"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_fk" FOREIGN KEY ("facility_id","order_id") REFERENCES "public"."escrow_orders"("facility_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_supplier_fk" FOREIGN KEY ("facility_id","supplier_id") REFERENCES "public"."suppliers"("facility_id","supplier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shortlists" ADD CONSTRAINT "shortlists_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_evidence" ADD CONSTRAINT "supplier_evidence_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_evidence" ADD CONSTRAINT "supplier_evidence_supplier_fk" FOREIGN KEY ("facility_id","supplier_id") REFERENCES "public"."suppliers"("facility_id","supplier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_actions" ADD CONSTRAINT "chain_actions_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "denials" ADD CONSTRAINT "denials_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payee_fk" FOREIGN KEY ("facility_id","payee_id") REFERENCES "public"."payees"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_fk" FOREIGN KEY ("facility_id","order_id") REFERENCES "public"."escrow_orders"("facility_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_chain_action_fk" FOREIGN KEY ("facility_id","chain_action_id") REFERENCES "public"."chain_actions"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_runs" ADD CONSTRAINT "evidence_runs_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founders_facility_passkey_credential_id_unique" ON "founders" USING btree ("facility_id","passkey_credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_session_seq_unique" ON "chat_messages" USING btree ("facility_id","session_id","seq");--> statement-breakpoint
CREATE INDEX "memory_entries_facility_key_idx" ON "memory_entries" USING btree ("facility_id","key");--> statement-breakpoint
CREATE INDEX "plans_facility_version_idx" ON "plans" USING btree ("facility_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_facility_committed_version_unique" ON "plans" USING btree ("facility_id","version") WHERE "plans"."status" IN ('COMMITTED', 'SUPERSEDED');--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_facility_invoice_hash_unique" ON "invoices" USING btree ("facility_id","invoice_hash");--> statement-breakpoint
CREATE INDEX "supplier_evidence_supplier_idx" ON "supplier_evidence" USING btree ("facility_id","supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_actions_signer_nonce_unique" ON "chain_actions" USING btree ("signer_address","chain_id","nonce") WHERE "chain_actions"."nonce" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chain_actions_state_idx" ON "chain_actions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "chain_actions_ref_idx" ON "chain_actions" USING btree ("facility_id","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_facility_intent_id_unique" ON "payments" USING btree ("facility_id","intent_id") WHERE "payments"."state" NOT IN ('POLICY_DENIED', 'REVERTED', 'CANCELLED');--> statement-breakpoint
CREATE UNIQUE INDEX "payments_signer_nonce_unique" ON "payments" USING btree ("signer_address","chain_id","nonce") WHERE "payments"."nonce" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_facility_state_idx" ON "payments" USING btree ("facility_id","state");--> statement-breakpoint
CREATE INDEX "payments_state_idx" ON "payments" USING btree ("state");--> statement-breakpoint
CREATE INDEX "payments_rationale_hash_idx" ON "payments" USING btree ("rationale_hash");--> statement-breakpoint
CREATE INDEX "payments_tx_hash_idx" ON "payments" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_facility_stripe_event_id_unique" ON "sales" USING btree ("facility_id","stripe_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_facility_sale_id_hash_unique" ON "sales" USING btree ("facility_id","sale_id_hash");--> statement-breakpoint
CREATE INDEX "exceptions_facility_status_idx" ON "exceptions" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "signature_requests_ref_idx" ON "signature_requests" USING btree ("facility_id","kind","ref_id");--> statement-breakpoint
CREATE INDEX "llm_calls_trace_idx" ON "llm_calls" USING btree ("facility_id","trace_id");--> statement-breakpoint
CREATE INDEX "traces_facility_ts_idx" ON "traces" USING btree ("facility_id","ts");--> statement-breakpoint
CREATE INDEX "traces_payment_idx" ON "traces" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "traces_decision_idx" ON "traces" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "traces_tx_hash_idx" ON "traces" USING btree ("tx_hash");