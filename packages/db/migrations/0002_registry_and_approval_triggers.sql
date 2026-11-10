-- A new registry head must be exactly the org's current max version + 1 (the first is 1).
CREATE FUNCTION payee_registry_heads_check_version() RETURNS trigger AS $$
DECLARE
  expected integer;
BEGIN
  SELECT COALESCE(MAX(version), 0) + 1 INTO expected
    FROM payee_registry_heads WHERE org_id = NEW.org_id;
  IF NEW.version <> expected THEN
    RAISE EXCEPTION 'payee_registry_heads version must be %, got %', expected, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payee_registry_heads_version_sequence
  BEFORE INSERT ON payee_registry_heads
  FOR EACH ROW EXECUTE FUNCTION payee_registry_heads_check_version();
--> statement-breakpoint
-- Approvals are immutable. The one permitted update sets revoked_at from NULL to a value, once.
CREATE FUNCTION payee_approvals_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.revoked_at IS NULL
    AND NEW.revoked_at IS NOT NULL
    AND to_jsonb(NEW) - 'revoked_at' = to_jsonb(OLD) - 'revoked_at' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payee_approvals is immutable: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payee_approvals_immutable
  BEFORE UPDATE OR DELETE ON payee_approvals
  FOR EACH ROW EXECUTE FUNCTION payee_approvals_guard();
--> statement-breakpoint
CREATE TRIGGER payee_approvals_no_truncate
  BEFORE TRUNCATE ON payee_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION payee_approvals_guard();
