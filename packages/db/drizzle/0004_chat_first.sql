CREATE TABLE "supplier_terms" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"shortlist_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"chosen_index" integer NOT NULL,
	"currency" text NOT NULL,
	"quote_total_minor" numeric(39, 0) NOT NULL,
	"quantity" integer NOT NULL,
	"terms_json" jsonb NOT NULL,
	"schedule_json" jsonb NOT NULL,
	"payout_account_ref" text NOT NULL,
	"payout_account_hash" text NOT NULL,
	"bank_name" text NOT NULL,
	"payee_type" text NOT NULL,
	"quote_hash" text NOT NULL,
	"status" text DEFAULT 'CONFIRMED' NOT NULL,
	"order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_terms_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "supplier_terms_status" CHECK ("supplier_terms"."status" IN ('CONFIRMED', 'SUPERSEDED', 'USED')),
	CONSTRAINT "supplier_terms_used_iff_order" CHECK (("supplier_terms"."status" = 'USED') = ("supplier_terms"."order_id" IS NOT NULL)),
	CONSTRAINT "supplier_terms_chosen_index_uint8" CHECK ("supplier_terms"."chosen_index" >= 0 AND "supplier_terms"."chosen_index" <= 255),
	CONSTRAINT "supplier_terms_quantity_positive" CHECK ("supplier_terms"."quantity" >= 1),
	CONSTRAINT "supplier_terms_currency_iso4217" CHECK ("supplier_terms"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "supplier_terms_payee_company" CHECK ("supplier_terms"."payee_type" = 'company'),
	CONSTRAINT "supplier_terms_terms_json_array" CHECK (jsonb_typeof("supplier_terms"."terms_json") = 'array'),
	CONSTRAINT "supplier_terms_schedule_json_array" CHECK (jsonb_typeof("supplier_terms"."schedule_json") = 'array'),
	CONSTRAINT "supplier_terms_payout_account_hash_hex32" CHECK ("supplier_terms"."payout_account_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "supplier_terms_quote_hash_hex32" CHECK ("supplier_terms"."quote_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "supplier_terms_quote_total_minor_nonneg" CHECK ("supplier_terms"."quote_total_minor" >= 0),
	CONSTRAINT "supplier_terms_quote_total_minor_uint128" CHECK ("supplier_terms"."quote_total_minor" <= 340282366920938463463374607431768211455)
);
--> statement-breakpoint
ALTER TABLE "shortlists" ADD COLUMN "source" text DEFAULT 'catalog' NOT NULL;--> statement-breakpoint
ALTER TABLE "shortlists" ADD COLUMN "search_json" jsonb;--> statement-breakpoint
ALTER TABLE "supplier_terms" ADD CONSTRAINT "supplier_terms_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_terms" ADD CONSTRAINT "supplier_terms_supplier_fk" FOREIGN KEY ("facility_id","supplier_id") REFERENCES "public"."suppliers"("facility_id","supplier_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_terms" ADD CONSTRAINT "supplier_terms_shortlist_fk" FOREIGN KEY ("facility_id","shortlist_id") REFERENCES "public"."shortlists"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_terms" ADD CONSTRAINT "supplier_terms_order_fk" FOREIGN KEY ("facility_id","order_id") REFERENCES "public"."escrow_orders"("facility_id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_terms_facility_supplier_live_unique" ON "supplier_terms" USING btree ("facility_id","supplier_id") WHERE "supplier_terms"."status" IN ('CONFIRMED', 'USED');--> statement-breakpoint
ALTER TABLE "shortlists" ADD CONSTRAINT "shortlists_source" CHECK ("shortlists"."source" IN ('catalog', 'web'));