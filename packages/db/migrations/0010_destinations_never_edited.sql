-- A destination's identity never changes (L25): a new address is a new row. Only its check result,
-- status and flags move, and a superseded destination stays superseded.
CREATE FUNCTION payout_destinations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'payout_destinations are never deleted: % is not allowed', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.contractor_id IS DISTINCT FROM OLD.contractor_id
    OR NEW.route IS DISTINCT FROM OLD.route
    OR NEW.chain IS DISTINCT FROM OLD.chain
    OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
    OR NEW.payout_mode IS DISTINCT FROM OLD.payout_mode
    OR NEW.address IS DISTINCT FROM OLD.address THEN
    RAISE EXCEPTION 'a payout destination''s address is never edited: create a new one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION 'a superseded payout destination stays superseded'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payout_destinations_never_edited
  BEFORE UPDATE OR DELETE ON payout_destinations
  FOR EACH ROW EXECUTE FUNCTION payout_destinations_guard();
--> statement-breakpoint
CREATE TRIGGER payout_destinations_no_truncate
  BEFORE TRUNCATE ON payout_destinations
  FOR EACH STATEMENT EXECUTE FUNCTION payout_destinations_guard();
--> statement-breakpoint
-- Contractors are archived, never deleted.
CREATE FUNCTION contractors_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'contractors are archived, never deleted: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER contractors_no_delete
  BEFORE DELETE ON contractors
  FOR EACH ROW EXECUTE FUNCTION contractors_block_delete();
--> statement-breakpoint
CREATE TRIGGER contractors_no_truncate
  BEFORE TRUNCATE ON contractors
  FOR EACH STATEMENT EXECUTE FUNCTION contractors_block_delete();
