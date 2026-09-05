-- STATUS: APPLIED (version 20260805053214, confirmed live via list_migrations, 2026-08-06).
--
-- ============================================================================
-- 117: Add the tournament-module tables to the supabase_realtime publication.
-- ============================================================================
-- Root cause fix for "tournament/division/registration data disappears after
-- refresh" — confirmed live (queried pg_publication_tables directly) that
-- tournaments/tournament_divisions/tournament_registrations/tournament_matches
-- were never added to the publication, even though the app's
-- subscribeTournaments/subscribeDivisions/subscribeRegistrations/
-- subscribeTournamentMatches (src/lib/cloud.js) and their additive-merge
-- onChange handlers were already correctly written. Those channels opened
-- successfully but silently never received a single event, because Postgres
-- never published changes on these tables to the replication stream they
-- listen to. A write that hadn't yet drained through the Outbox at the moment
-- of a page refresh/panel remount was therefore invisible until another
-- unrelated full refetch happened to occur later — reading as "created it,
-- refreshed, it's gone" even though the row was sitting correctly in the
-- database the whole time.
--
-- No RLS or application-code change needed — this is the one missing piece.
-- Every other realtime channel in src/lib/cloud.js was checked against the
-- live publication list and already targets a published table
-- (events, notifications, matches, live_matches, live_sessions,
-- match_organizer_invites) — these 4 tournament tables were the only gap.
-- ============================================================================

alter publication supabase_realtime add table
  public.tournaments,
  public.tournament_divisions,
  public.tournament_registrations,
  public.tournament_matches;
