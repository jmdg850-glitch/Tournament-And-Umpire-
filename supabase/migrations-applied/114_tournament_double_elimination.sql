-- STATUS: APPLIED (version 20260804084343, confirmed live via list_migrations, 2026-08-04).
-- NOTE: the phantom_slot CHECK constraint below was widened from the original
-- ('A','B') to ('A','B','both') BEFORE this was ever applied live, after
-- discovering tournamentDoubleElimination.js's own fixed-point cascade
-- legitimately produces 'both' for the double-phantom edge case (two
-- adjacent winners-bracket-round-1 byes feeding the same losers-bracket
-- match). What's in this file is what's live — there is no drift to reconcile.
--
-- ============================================================================
-- 114: Double Elimination as a third tournament_divisions format, plus the
--      losers-bracket/grand-final columns tournament_matches needs to carry it.
-- ============================================================================
-- Does not touch, alter, or delete any existing row. Every existing
-- round_robin/single_elimination division and match is unaffected — the new
-- columns are nullable, never set by anything but double-elimination code.
--
-- The format check on tournament_divisions was declared as an unnamed inline
-- constraint in 112 (`format text not null check (...)`), so its real name is
-- whatever Postgres auto-generated. Rather than guess it, find and drop it
-- dynamically by inspecting its definition — safe to re-run (drops whatever
-- constraint currently enforces the format check, by whatever name, and
-- re-adds it under a stable explicit name each time).
-- ============================================================================

do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'tournament_divisions'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%format%';
  if cname is not null then
    execute format('alter table public.tournament_divisions drop constraint %I', cname);
  end if;
end $$;

alter table public.tournament_divisions
  add constraint tournament_divisions_format_check
  check (format in ('round_robin','single_elimination','double_elimination'));

-- bracket_side distinguishes a double-elimination match's winners-bracket/losers-bracket/
-- grand-final membership (null for round_robin/single_elimination, which don't need it).
-- loser_next_match_id/slot mirror the existing next_match_id/next_match_slot naming — the
-- winner's destination is unchanged (next_match_id/slot); these two carry the LOSER'S
-- destination in the losers bracket, only ever set on winners-bracket matches.
-- phantom_slot marks a losers-bracket match where one slot will structurally NEVER receive a
-- real entrant (its would-be feeder was itself a bye, cascading at most one level through the
-- losers bracket — see tournamentDoubleElimination.js) — lets the advancement code resolve
-- that match as an immediate walkover the moment its one real slot fills, instead of the match
-- waiting forever for an opponent who can never arrive. Deliberately NOT represented with a
-- sentinel value in registration_a_id/b_id, since those columns are FK-constrained to real
-- tournament_registrations rows. 'both' additionally covers the rarer case where BOTH slots are
-- structurally phantom (two adjacent byes feeding the same losers-bracket match, only possible
-- in a sparse bracket) — that match is pre-resolved as an empty bye at generation time and never
-- has a real participant on either side; see tournamentDoubleElimination.js's fixed-point
-- cascade for how this is detected and propagated.
alter table public.tournament_matches
  add column if not exists bracket_side text
    check (bracket_side in ('winners','losers','final')),
  add column if not exists loser_next_match_id text references public.tournament_matches(id),
  add column if not exists loser_next_match_slot text
    check (loser_next_match_slot in ('A','B')),
  add column if not exists phantom_slot text
    check (phantom_slot in ('A','B','both'));
