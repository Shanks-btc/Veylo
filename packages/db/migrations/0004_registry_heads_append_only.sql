-- payee_registry_heads is append-only: block UPDATE, DELETE and TRUNCATE.
CREATE FUNCTION payee_registry_heads_block_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payee_registry_heads is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payee_registry_heads_no_update_or_delete
  BEFORE UPDATE OR DELETE ON payee_registry_heads
  FOR EACH ROW EXECUTE FUNCTION payee_registry_heads_block_change();
--> statement-breakpoint
CREATE TRIGGER payee_registry_heads_no_truncate
  BEFORE TRUNCATE ON payee_registry_heads
  FOR EACH STATEMENT EXECUTE FUNCTION payee_registry_heads_block_change();
