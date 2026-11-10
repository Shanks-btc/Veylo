CREATE TABLE "encumbrances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encumbrances_attempt_id_unique" UNIQUE("attempt_id"),
	CONSTRAINT "encumbrances_amount_positive" CHECK ("encumbrances"."amount" > 0),
	CONSTRAINT "encumbrances_reason_iff_released" CHECK (("encumbrances"."released_at" IS NULL) = ("encumbrances"."reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sign_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "submit_outcome" text;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "submit_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "status_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "terminal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "expired_unsubmitted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "encrypted_signed_payload" text;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "payload_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "balance_unconfirmed" boolean;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "observed_balance" text;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "failure_detail" text;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "last_status" jsonb;--> statement-breakpoint
ALTER TABLE "encumbrances" ADD CONSTRAINT "encumbrances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_org_id_id_unique" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "encumbrances" ADD CONSTRAINT "encumbrances_attempt_same_org" FOREIGN KEY ("org_id","attempt_id") REFERENCES "public"."payout_attempts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_requests" ADD CONSTRAINT "sign_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_requests" ADD CONSTRAINT "sign_requests_attempt_same_org" FOREIGN KEY ("org_id","attempt_id") REFERENCES "public"."payout_attempts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "encumbrances_org_id_idx" ON "encumbrances" USING btree ("org_id");