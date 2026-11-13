ALTER TYPE "public"."membership_role" ADD VALUE IF NOT EXISTS 'preparer';--> statement-breakpoint
CREATE TABLE "payroll_schedules" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"day_of_month" integer,
	"anchor_date" date,
	"time_zone" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_schedules_kind_known" CHECK ("payroll_schedules"."kind" IN ('monthly', 'biweekly')),
	CONSTRAINT "payroll_schedules_monthly_day" CHECK ("payroll_schedules"."kind" <> 'monthly' OR ("payroll_schedules"."day_of_month" BETWEEN 1 AND 31 AND "payroll_schedules"."anchor_date" IS NULL)),
	CONSTRAINT "payroll_schedules_biweekly_anchor" CHECK ("payroll_schedules"."kind" <> 'biweekly' OR ("payroll_schedules"."anchor_date" IS NOT NULL AND "payroll_schedules"."day_of_month" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "payroll_schedules" ADD CONSTRAINT "payroll_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "scheduled_for" date;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "ready_for_review_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "pay_runs_org_scheduled_for_unique" ON "pay_runs" USING btree ("org_id","scheduled_for") WHERE "pay_runs"."scheduled_for" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "contractors" ADD COLUMN "user_id" uuid;--> statement-breakpoint
CREATE TABLE "contractor_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contractor_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contractor_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "contractor_invites" ADD CONSTRAINT "contractor_invites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "address_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"contractor_id" uuid NOT NULL,
	"route" text NOT NULL,
	"address" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applies_after" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "address_change_requests" ADD CONSTRAINT "address_change_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "address_change_requests_contractor_idx" ON "address_change_requests" USING btree ("org_id","contractor_id");--> statement-breakpoint
CREATE TABLE "item_acknowledgements" (
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_acknowledgements_item_id_user_id_pk" PRIMARY KEY("item_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "item_acknowledgements" ADD CONSTRAINT "item_acknowledgements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
