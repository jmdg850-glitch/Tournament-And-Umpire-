-- STATUS: APPLIED (version 20260727133440, confirmed live via list_migrations, 2026-07-28).
-- Applied right after 104, outside this repo's local file history until this reconciliation pass
-- — recovered verbatim from supabase_migrations.schema_migrations.statements.
--
-- Closes a gap where rls_auto_enable() (a helper used while rolling out RLS across tables) was
-- still executable by the public role after its rollout job was done.

revoke execute on function public.rls_auto_enable() from public;
