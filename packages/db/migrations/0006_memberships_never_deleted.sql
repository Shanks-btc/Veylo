-- Memberships are never deleted (L22): removal sets status and removed_at.
CREATE FUNCTION memberships_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'memberships are never deleted: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER memberships_no_delete
  BEFORE DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_block_delete();
--> statement-breakpoint
CREATE TRIGGER memberships_no_truncate
  BEFORE TRUNCATE ON memberships
  FOR EACH STATEMENT EXECUTE FUNCTION memberships_block_delete();
