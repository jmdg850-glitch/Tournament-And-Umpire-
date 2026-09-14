// Addressable-navigation hash for the tournament desk shell — #/t/<tournamentId>/<tab>.
// Deliberately hand-rolled to match the existing #/live/<tournamentId>/<matchId>
// scheme (see packages/engine/src/liveSync.js's parseLiveHash) rather than adding
// a routing library: the packaged Electron app always loads dist/index.html via
// file://, and neither apps/operator/vercel.json nor the root Vercel config has an
// SPA-fallback rewrite, so a path-based (History API) router would 404 on reload —
// a hash never reaches the server or the file:// loader, so it has no such problem.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DESK_HASH_RE = new RegExp(`^#?/?t/(${UUID})(?:/([a-z]+))?/?$`, "i");

export function parseDeskHash(hash) {
  const match = String(hash || "").match(DESK_HASH_RE);
  if (!match) return null;
  return { tournamentId: match[1], tab: match[2] || null };
}

export function buildDeskHash(tournamentId, tab) {
  return `#/t/${tournamentId}/${tab}`;
}
