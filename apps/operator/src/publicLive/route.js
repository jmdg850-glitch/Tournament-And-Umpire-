// Path-based route for the public "Live" spectator page — /live/<slug-or-id>.
// Deliberately a real path, not a hash like every other route in this app
// (see deskHash.js's header comment for why the app otherwise avoids
// path-based routing): this is the one URL that must be typeable, scannable
// from a QR code, and survive a hard refresh/direct link from a spectator's
// phone, which a hash-only scheme can't offer without a Vercel SPA rewrite.
// That rewrite is added (see apps/operator/vercel.json) scoped to exactly
// this path, so it doesn't change 404 behavior anywhere else in the app.
// Under Electron, window.location.pathname is a file:// filesystem path and
// can never match this, so this route is naturally a no-op there.
const SLUG_OR_ID_RE = /^[a-z0-9-]{1,80}$/i;

export function parsePublicLiveRoute(pathname) {
  const match = String(pathname || "").match(/^\/live\/([^/]+)\/?$/);
  if (!match) return null;
  const slugOrId = match[1];
  if (!SLUG_OR_ID_RE.test(slugOrId)) return null;
  return { slugOrId };
}

export function publicLivePath(slugOrId) {
  return `/live/${slugOrId}`;
}
