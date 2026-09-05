-- ============================================================================
-- 142: Team Elimination — Individual-Pair Semifinal/Bronze/Final qualification.
-- ============================================================================
-- Per the corrected spec, the Semifinal/Bronze/Final stage is no longer a
-- Top-4-TEAMS bracket (134-138) — it's the Top-4 INDIVIDUAL PAIRS from the
-- round-robin stage's accumulated individual W/L/PF/PA record (no team quota;
-- all 4 semifinalists may belong to the same team). pair_a_id/pair_b_id are
-- the new AUTHORITATIVE participant columns for semifinal/bronze/final-stage
-- tournament_team_matchups rows (pairs_per_matchup=1 for those rows).
-- team_a_id/team_b_id (136) are KEPT and still populated for these rows —
-- informational team-of-origin display only from this stage on, never used
-- for qualification or match generation (may legitimately be equal to each
-- other when both semifinalists share a team). Round-robin-stage rows
-- (stage='round_robin') never set pair_a_id/pair_b_id — they remain
-- team_a_id/team_b_id-only, exactly as today.
--
-- on delete set null (not cascade) — mirrors tournament_registrations.team_id's
-- own precedent (134): a later-withdrawn/deleted pair must not delete an
-- already-decided historical bracket slot (score, winner_team_id, stage_label
-- all remain meaningful even if the underlying registration is later removed).
--
-- No stage/status constraint changes needed — 138 already allows
-- 'semifinal'/'bronze'/'final'. Realtime publication already includes
-- tournament_team_matchups (136) — no new publication statement needed.
-- ============================================================================

alter table public.tournament_team_matchups
  add column if not exists pair_a_id text references public.tournament_registrations(id) on delete set null;
alter table public.tournament_team_matchups
  add column if not exists pair_b_id text references public.tournament_registrations(id) on delete set null;

create index if not exists tournament_team_matchups_pair_a_idx on public.tournament_team_matchups (pair_a_id);
create index if not exists tournament_team_matchups_pair_b_idx on public.tournament_team_matchups (pair_b_id);
