-- STATUS: APPLIED (confirmed live via list_migrations, 2026-07-28).
--
-- Follow-up to 106, caught by a final get_advisors sweep after that migration: the two trigger
-- functions it created were left publicly callable via PostgREST RPC (SECURITY DEFINER functions
-- are exposed at /rest/v1/rpc/<name> by default unless EXECUTE is revoked). They're only ever
-- meant to run as BEFORE UPDATE triggers — revoking direct RPC access doesn't affect trigger
-- firing (that isn't gated by a role's EXECUTE grant), confirmed by re-running the same
-- self-cleaning reassignment test from 106 after this ran: still correctly rejected.
revoke all on function public.pin_live_matches_organizer_id() from public, anon, authenticated;
revoke all on function public.pin_event_attendees_identity() from public, anon, authenticated;
