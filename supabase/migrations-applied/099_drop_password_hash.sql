-- ============================================================================
-- 099: Drop legacy world-readable password_hash column
-- ============================================================================
-- STATUS: APPLIED (confirmed live via list_migrations, 2026-07-28).
--
-- accounts.password_hash survives from the pre-Supabase-Auth era. Confirmed
-- via pg_policies that the current `accounts read` policy is `USING (true)`,
-- so anyone holding the anon key can `select password_hash from accounts`
-- today. Confirmed via grep that nothing in src/lib/cloud.js or src/App.jsx
-- reads this column — Supabase Auth owns credentials; accounts is profile-only.
--
-- IRREVERSIBLE without a separate database backup: take one before applying
-- to production, even though this has already been verified safe on a branch.
-- ============================================================================

alter table public.accounts drop column if exists password_hash;
