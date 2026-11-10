ALTER TABLE "pay_runs" DROP CONSTRAINT "pay_runs_approved_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_approver_is_member" FOREIGN KEY ("org_id","approved_by") REFERENCES "public"."memberships"("org_id","user_id") ON DELETE no action ON UPDATE no action;