// Same ownership + accepted-co-organizer gate as canControlEvent (lib/mixmatch.js),
// applied to the tournament entity — no new role concept, per the approved design.
export function canControlTournament(tournament, currentUser){
  if (!tournament) return false;
  if (currentUser?.role === "admin") return true;
  if (tournament.ownerId === currentUser?.id) return true;
  return (tournament.organizerIds || []).includes(currentUser?.id);
}
