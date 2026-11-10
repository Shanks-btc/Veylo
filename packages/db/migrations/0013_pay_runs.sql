ALTER TABLE "pay_run_items" ALTER COLUMN "destination_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_run_items" ADD COLUMN "fee_preview" jsonb;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "requested_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD COLUMN "signed_message_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pay_run_items" ADD CONSTRAINT "pay_run_items_one_per_contractor" UNIQUE("pay_run_id","contractor_id");