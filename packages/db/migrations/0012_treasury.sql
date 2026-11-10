CREATE TYPE "public"."oneclick_session_status" AS ENUM('active', 'needs_resign');--> statement-breakpoint
CREATE TYPE "public"."treasury_event_type" AS ENUM('fund', 'shield');--> statement-breakpoint
CREATE TABLE "org_data_keys" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions_1click" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"status" "oneclick_session_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_1click_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "treasury_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "treasury_event_type" NOT NULL,
	"origin_asset" text NOT NULL,
	"origin_amount" numeric(78, 0) NOT NULL,
	"destination_amount" bigint NOT NULL,
	"quote" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"deposit_address" text NOT NULL,
	"status" text NOT NULL,
	"status_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_status" jsonb,
	"payload" jsonb,
	"intent_hash" text,
	"expires_at" timestamp with time zone,
	"mode" "mode" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_events_deposit_address_unique" UNIQUE("deposit_address"),
	CONSTRAINT "treasury_events_org_id_id_unique" UNIQUE("org_id","id"),
	CONSTRAINT "treasury_events_amounts_non_negative" CHECK ("treasury_events"."origin_amount" >= 0 AND "treasury_events"."destination_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "treasury_session_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"message" text NOT NULL,
	"nonce" text NOT NULL,
	"recipient" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_session_requests_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
ALTER TABLE "payee_approvals" ADD COLUMN "message" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payee_approvals" ADD COLUMN "contractor_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payee_requests" ADD COLUMN "contractor_name" text;--> statement-breakpoint
ALTER TABLE "org_data_keys" ADD CONSTRAINT "org_data_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions_1click" ADD CONSTRAINT "sessions_1click_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_events" ADD CONSTRAINT "treasury_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_session_requests" ADD CONSTRAINT "treasury_session_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treasury_events_org_id_idx" ON "treasury_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "treasury_session_requests_org_id_idx" ON "treasury_session_requests" USING btree ("org_id");