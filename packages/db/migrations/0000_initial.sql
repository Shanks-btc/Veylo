CREATE TYPE "public"."attempt_status" AS ENUM('PLANNED', 'QUOTED', 'SIGNED', 'SUBMITTED', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."failure_reason" AS ENUM('quote_rejected', 'gate_blocked', 'generate_intent_rejected', 'submit_rejected', 'settlement_failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'viewer', 'accountant');--> statement-breakpoint
CREATE TYPE "public"."mode" AS ENUM('live', 'simulated');--> statement-breakpoint
CREATE TYPE "public"."pay_run_status" AS ENUM('Draft', 'Prepared', 'InReview', 'Quoting', 'Signing', 'Settling', 'Completed', 'PartiallyCompleted');--> statement-breakpoint
CREATE TYPE "public"."payout_mode" AS ENUM('direct', 'private');--> statement-breakpoint
CREATE TYPE "public"."prepared_by" AS ENUM('agent', 'user');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"details_hash" text,
	"tx_hash" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contractors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"terms" jsonb NOT NULL,
	"payout_mode" "payout_mode" NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contractors_org_id_id_unique" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pay_run_id" uuid NOT NULL,
	"contractor_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"amount_usdc" bigint NOT NULL,
	"basis" jsonb NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" "mode" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_run_items_org_id_id_unique" UNIQUE("org_id","id"),
	CONSTRAINT "pay_run_items_amount_non_negative" CHECK ("pay_run_items"."amount_usdc" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pay_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" "pay_run_status" NOT NULL,
	"prepared_by" "prepared_by" NOT NULL,
	"approved_by" uuid,
	"total_amount_usdc" bigint NOT NULL,
	"mode" "mode" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_runs_org_id_id_unique" UNIQUE("org_id","id"),
	CONSTRAINT "pay_runs_total_non_negative" CHECK ("pay_runs"."total_amount_usdc" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payee_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"owner_account_id" text NOT NULL,
	"owner_public_key" text NOT NULL,
	"signature" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "payee_approvals_destination_version_unique" UNIQUE("destination_id","version")
);
--> statement-breakpoint
CREATE TABLE "payee_registry_heads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"active_set_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"owner_public_key" text NOT NULL,
	"signature" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payee_registry_heads_org_version_unique" UNIQUE("org_id","version")
);
--> statement-breakpoint
CREATE TABLE "payout_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"line_item_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"quote_request" jsonb,
	"quote" jsonb,
	"deposit_address" text,
	"correlation_id" text,
	"deadline" timestamp with time zone,
	"min_amount_in" bigint,
	"amount_in" bigint,
	"fees" jsonb,
	"intent_hash" text,
	"status" "attempt_status" NOT NULL,
	"failure_reason" "failure_reason",
	"status_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settlement_intent_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"near_tx_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"destination_tx_hash" text,
	"refunded_amount" bigint,
	"reconciled_at" timestamp with time zone,
	"mode" "mode" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_attempts_deposit_address_unique" UNIQUE("deposit_address"),
	CONSTRAINT "payout_attempts_line_item_attempt_unique" UNIQUE("line_item_id","attempt_no"),
	CONSTRAINT "payout_attempts_failure_reason_iff_failed" CHECK (("payout_attempts"."status" = 'FAILED') = ("payout_attempts"."failure_reason" IS NOT NULL)),
	CONSTRAINT "payout_attempts_attempt_no_positive" CHECK ("payout_attempts"."attempt_no" >= 1),
	CONSTRAINT "payout_attempts_amounts_non_negative" CHECK ("payout_attempts"."min_amount_in" >= 0 AND "payout_attempts"."amount_in" >= 0 AND "payout_attempts"."refunded_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payout_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contractor_id" uuid NOT NULL,
	"chain" text NOT NULL,
	"asset_id" text NOT NULL,
	"address" text NOT NULL,
	"validated_at" timestamp with time zone,
	"received_public_payout" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"control_proof" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_destinations_org_id_id_unique" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "treasuries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"near_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasuries_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"near_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_near_account_id_unique" UNIQUE("near_account_id")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_items" ADD CONSTRAINT "pay_run_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_items" ADD CONSTRAINT "pay_run_items_pay_run_same_org" FOREIGN KEY ("org_id","pay_run_id") REFERENCES "public"."pay_runs"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_items" ADD CONSTRAINT "pay_run_items_contractor_same_org" FOREIGN KEY ("org_id","contractor_id") REFERENCES "public"."contractors"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_items" ADD CONSTRAINT "pay_run_items_destination_same_org" FOREIGN KEY ("org_id","destination_id") REFERENCES "public"."payout_destinations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee_approvals" ADD CONSTRAINT "payee_approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee_approvals" ADD CONSTRAINT "payee_approvals_destination_same_org" FOREIGN KEY ("org_id","destination_id") REFERENCES "public"."payout_destinations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee_registry_heads" ADD CONSTRAINT "payee_registry_heads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_line_item_same_org" FOREIGN KEY ("org_id","line_item_id") REFERENCES "public"."pay_run_items"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_contractor_same_org" FOREIGN KEY ("org_id","contractor_id") REFERENCES "public"."contractors"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasuries" ADD CONSTRAINT "treasuries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_id_idx" ON "audit_log" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "contractors_org_id_idx" ON "contractors" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "pay_run_items_pay_run_id_idx" ON "pay_run_items" USING btree ("pay_run_id");--> statement-breakpoint
CREATE INDEX "pay_runs_org_id_idx" ON "pay_runs" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_attempts_one_non_terminal_per_item" ON "payout_attempts" USING btree ("line_item_id") WHERE "payout_attempts"."status" IN ('PLANNED', 'QUOTED', 'SIGNED', 'SUBMITTED', 'PROCESSING');--> statement-breakpoint
CREATE INDEX "payout_destinations_org_id_idx" ON "payout_destinations" USING btree ("org_id");