// Pure helper shared by DivisionDetailPanel.jsx (schedule/bracket generation) and App.jsx
// (bracket advancement) — the two places a tournament_matches row's registrationAId/
// registrationBId slot gets filled with a real player. Kept dependency-free (no cloud.js/
// App.jsx imports) to avoid any circular-import risk between those two call sites.
//
// Resolves a match's real notifiable PickleLive account ids — only each side's
// linkedAccountIds (registrations.player_ids that are actual linked accounts with a login),
// never an unlinked guest/walk-in roster entry, since there's no account to notify.
export function resolveMatchNotifyRecipients(match, registrations) {
  if (!match || !registrations) return [];
  const ids = new Set();
  const regA = registrations.find(r => r.id === match.registrationAId);
  const regB = registrations.find(r => r.id === match.registrationBId);
  [regA, regB].forEach(r => { (r?.linkedAccountIds || []).forEach(id => ids.add(id)); });
  return [...ids];
}
