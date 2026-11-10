CREATE TYPE "public"."destination_check" AS ENUM('accepted', 'rejected', 'check_failed');--> statement-breakpoint
CREATE TYPE "public"."destination_status" AS ENUM('candidate', 'active', 'superseded');--> statement-breakpoint
ALTER TABLE "contractors" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "contractors" ALTER COLUMN "payout_mode" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "route" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "payout_mode" "payout_mode" NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "status" "destination_status" DEFAULT 'candidate' NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "check_status" "destination_check" DEFAULT 'check_failed' NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "check_reason" text;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD COLUMN "fee_preview" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_destinations_one_active_per_contractor" ON "payout_destinations" USING btree ("contractor_id") WHERE "payout_destinations"."status" = 'active';--> statement-breakpoint
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_status_known" CHECK ("contractors"."status" IN ('active', 'archived'));--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_superseded_at_iff_superseded" CHECK (("payout_destinations"."status" = 'superseded') = ("payout_destinations"."superseded_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_active_needs_accepted" CHECK ("payout_destinations"."status" <> 'active' OR "payout_destinations"."check_status" = 'accepted');