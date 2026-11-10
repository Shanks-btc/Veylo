-- An approver must be an active owner at the moment of approval (L24). Later changes to their
-- membership don't undo a recorded approval. An account with no membership is left to the foreign key.
CREATE FUNCTION pay_runs_check_approver() RETURNS trigger AS $$
DECLARE
  approver_role membership_role;
  approver_status membership_status;
BEGIN
  IF NEW.approved_by IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by THEN
    RETURN NEW;
  END IF;
  -- The share lock makes a concurrent removal wait until this approval has committed.
  SELECT role, status INTO approver_role, approver_status
    FROM memberships
    WHERE org_id = NEW.org_id AND user_id = NEW.approved_by
    FOR SHARE;
  IF FOUND AND (approver_status <> 'active' OR approver_role <> 'owner') THEN
    RAISE EXCEPTION 'pay_runs approver must be an active owner'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER pay_runs_approver_active_owner
  BEFORE INSERT OR UPDATE ON pay_runs
  FOR EACH ROW EXECUTE FUNCTION pay_runs_check_approver();
