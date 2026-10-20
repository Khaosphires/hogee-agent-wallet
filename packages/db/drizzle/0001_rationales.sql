CREATE TABLE "rationales" (
	"facility_id" text NOT NULL,
	"rationale_hash" text NOT NULL,
	"decision_id" uuid,
	"rationale_json" jsonb NOT NULL,
	"salt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rationales_pk" PRIMARY KEY("facility_id","rationale_hash"),
	CONSTRAINT "rationales_rationale_hash_hex32" CHECK ("rationales"."rationale_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "rationales_salt_hex32" CHECK ("rationales"."salt" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "rationales" ADD CONSTRAINT "rationales_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rationales_decision_idx" ON "rationales" USING btree ("facility_id","decision_id");