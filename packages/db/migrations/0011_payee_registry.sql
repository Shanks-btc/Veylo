CREATE TYPE "public"."entered_by" AS ENUM('owner', 'contractor');--> statement-breakpoint
CREATE TYPE "public"."payee_request_kind" AS ENUM('approve', 'revoke');--> statement-breakpoint
ALTER TYPE "public"."destination_check" ADD VALUE 'route_unavailable' BEFORE 'check_failed';--> statement-breakpoint
CREATE TABLE "payee_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "payee_request_kind" NOT NULL,
	"destination_id" uuid NOT NULL,
	"approval_id" uuid,
	"requested_by" uuid NOT NULL,
	"canonical_record" text,
	"record_hash" text,
	"approval_message" text,
	"approval_nonce" text,
	"approved_at" timestamp with time zone,
	"expires_record_at" timestamp with time zone,
	"approval_version" integer,
	"head_version" integer NOT NULL,
	"head_message" text NOT NULL,
	"head_nonce" text NOT NULL,
	"head_record_hashes" jsonb NOT NULL,
	"head_signed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payee_requests_approval_nonce_unique" UNIQUE("approval_nonce"),
	CONSTRAINT "payee_requests_head_nonce_unique" UNIQUE("head_nonce")
);
--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "entered_by" "entered_by" DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "contractor_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payee_requests" ADD CONSTRAINT "payee_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee_requests" ADD CONSTRAINT "payee_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee_requests" ADD CONSTRAINT "payee_requests_destination_same_org" FOREIGN KEY ("org_id","destination_id") REFERENCES "public"."payout_destinations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee_approvals" ADD CONSTRAINT "payee_approvals_org_id_id_unique" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "payee_requests" ADD CONSTRAINT "payee_requests_approval_same_org" FOREIGN KEY ("org_id","approval_id") REFERENCES "public"."payee_approvals"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payee_requests_org_id_idx" ON "payee_requests" USING btree ("org_id");