-- ============================================================================
-- 132: DUPR — rated divisions + real "Login with DUPR" SSO token storage.
-- Additive only. Nothing here alters, drops, or loosens any existing table,
-- column, or policy.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- tournament_divisions: per-division DUPR-rated flag (src/modals/
-- DivisionEditorModal.jsx). A tournament can mix DUPR-rated and non-rated
-- divisions, so this lives at the division level alongside format/win_to/
-- is_doubles — every other match-rule setting is already scoped there.
-- Existing tournament_divisions RLS (organizer/co-organizer/admin-scoped)
-- already covers this new column — no policy change needed.
-- ----------------------------------------------------------------------------
alter table public.tournament_divisions add column if not exists dupr_rated boolean not null default false;

-- ----------------------------------------------------------------------------
-- dupr_user_sso_tokens: the real "Login with DUPR" iframe flow (see DUPR's
-- RaaS docs, integration-checklist/sso-login) returns a userToken +
-- refreshToken scoped to the DUPR user who just logged in. These are DUPR API
-- access/refresh tokens — the ticket's own security requirements are explicit
-- that these must NEVER reach the frontend, so they are NOT added as columns
-- on `accounts` (my_account() does `select *` and is called from the client
-- on every profile load — adding them there would leak them on every read).
-- Kept in a dedicated table instead, RLS enabled with ZERO policies granted
-- to anon/authenticated — invisible to every JWT-authenticated request,
-- reachable only via the service-role key inside the SSO-handling Edge
-- Function. Exact mirror of dupr_auth_cache's (111_dupr_integration.sql)
-- established pattern for exactly this class of secret.
-- ----------------------------------------------------------------------------
create table if not exists public.dupr_user_sso_tokens (
  account_id text primary key references public.accounts(id) on delete cascade,
  user_token text not null,
  refresh_token text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.dupr_user_sso_tokens enable row level security;
-- Deliberately no select/insert/update/delete policy for authenticated/anon —
-- see header. Only the service-role key (bypasses RLS) ever touches this table.
