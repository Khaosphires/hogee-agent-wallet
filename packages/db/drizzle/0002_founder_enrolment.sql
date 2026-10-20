CREATE TABLE "founder_enrolment_codes" (
	"id" text NOT NULL,
	"facility_id" text NOT NULL,
	"founder_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"code_expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_credential_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "founder_enrolment_codes_pk" PRIMARY KEY("facility_id","id"),
	CONSTRAINT "founder_enrolment_codes_code_hash_hex32" CHECK ("founder_enrolment_codes"."code_hash" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "founder_enrolment_codes_used_names_credential" CHECK (("founder_enrolment_codes"."used_at" IS NULL) = ("founder_enrolment_codes"."used_credential_id" IS NULL)),
	CONSTRAINT "founder_enrolment_codes_used_xor_revoked" CHECK ("founder_enrolment_codes"."used_at" IS NULL OR "founder_enrolment_codes"."revoked_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "rejected_founder_keys" (
	"facility_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"founder_id" text NOT NULL,
	"qx" text NOT NULL,
	"qy" text NOT NULL,
	"registered_at" timestamp with time zone,
	"rejected_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rejected_founder_keys_pk" PRIMARY KEY("facility_id","credential_id"),
	CONSTRAINT "rejected_founder_keys_qx_hex32" CHECK ("rejected_founder_keys"."qx" ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "rejected_founder_keys_qy_hex32" CHECK ("rejected_founder_keys"."qy" ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "founders" ADD COLUMN "passkey_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "founder_enrolment_codes" ADD CONSTRAINT "founder_enrolment_codes_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "founder_enrolment_codes" ADD CONSTRAINT "founder_enrolment_codes_founder_fk" FOREIGN KEY ("facility_id","founder_id") REFERENCES "public"."founders"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejected_founder_keys" ADD CONSTRAINT "rejected_founder_keys_facility_id_facilities_facility_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("facility_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejected_founder_keys" ADD CONSTRAINT "rejected_founder_keys_founder_fk" FOREIGN KEY ("facility_id","founder_id") REFERENCES "public"."founders"("facility_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founder_enrolment_codes_one_open" ON "founder_enrolment_codes" USING btree ("facility_id") WHERE "founder_enrolment_codes"."used_at" IS NULL AND "founder_enrolment_codes"."revoked_at" IS NULL;