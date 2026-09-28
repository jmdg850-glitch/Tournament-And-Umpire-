// The single local home for "offline tournament packages": the last
// server-confirmed copy of the data a screen needs, saved per signed-in
// identity (`owner`, see offlineQueue.js ownerKey) in the app's existing
// IndexedDB store ("snapshots", DB v3). Screens read and write through this
// repository instead of keeping their own ad-hoc caches.
//
// Only SERVER-CONFIRMED data is ever saved here (a successful load, or a
// realtime row the server broadcast). Nothing here is a source of truth: the
// server always wins, and a saved copy is shown only as "saved data".

export const SNAPSHOT_SCHEMA = 1;

// Columns of court_devices safe to keep on disk. Everything else (notably
// refresh_token_hash) is dropped before a package is saved.
const COURT_DEVICE_COLUMNS = ["id", "court_id", "tournament_id", "status", "device_label", "paired_at", "revoked_at", "last_seen_at", "created_at"];

function pick(row, columns) {
  const out = {};
  for (const c of columns) {
    if (row && Object.prototype.hasOwnProperty.call(row, c)) out[c] = row[c];
  }
  return out;
}

// Returns a copy of loadDeskData()'s `data` that is safe to persist.
export function sanitizeDeskData(data) {
  if (!data || typeof data !== "object") return data;
  return {
    ...data,
    courtDevices: Array.isArray(data.courtDevices) ? data.courtDevices.map((d) => pick(d, COURT_DEVICE_COLUMNS)) : [],
  };
}

export function snapshotKey(owner, kind, id) {
  return id ? `${owner}|${kind}:${id}` : `${owner}|${kind}`;
}

// `store` is an offlineQueue.js store (IndexedDB or memory). Every method
// is best-effort for reads (a broken store behaves as "nothing saved") and
// never throws into a render path.
export function createTournamentRepository({ store, owner, now = () => Date.now() }) {
  const usable = Boolean(store && owner && typeof store.putSnapshot === "function");

  async function read(key) {
    if (!usable) return null;
    try {
      const snap = await store.getSnapshot(key);
      if (!snap || snap.owner !== owner || snap.schema !== SNAPSHOT_SCHEMA) return null;
      return snap;
    } catch {
      return null;
    }
  }

  async function write(snapshot) {
    if (!usable) return false;
    try {
      await store.putSnapshot(snapshot);
      return true;
    } catch {
      return false;
    }
  }

  return {
    owner,
    usable,
    async saveDesk(tournamentId, data, savedAt = now()) {
      if (!tournamentId || !data?.tournament) return false;
      return write({
        key: snapshotKey(owner, "tournament", tournamentId),
        owner,
        kind: "tournament",
        tournamentId,
        name: data.tournament?.name ?? null,
        data: sanitizeDeskData(data),
        savedAt,
        schema: SNAPSHOT_SCHEMA,
      });
    },
    async loadDesk(tournamentId) {
      if (!tournamentId) return null;
      return read(snapshotKey(owner, "tournament", tournamentId));
    },
    async saveDashboard({ rows, meta }, savedAt = now()) {
      return write({
        key: snapshotKey(owner, "dashboard"),
        owner,
        kind: "dashboard",
        tournamentId: null,
        data: { rows: Array.isArray(rows) ? rows : [], meta: meta ?? null },
        savedAt,
        schema: SNAPSHOT_SCHEMA,
      });
    },
    async loadDashboard() {
      return read(snapshotKey(owner, "dashboard"));
    },
    // Tournament ids with a saved package for this owner, newest first.
    async listOfflineReady() {
      if (!usable) return [];
      try {
        const all = await store.listSnapshots();
        return all
          .filter((s) => s.owner === owner && s.kind === "tournament" && s.schema === SNAPSHOT_SCHEMA)
          .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
          .map((s) => ({ tournamentId: s.tournamentId, name: s.name ?? null, savedAt: s.savedAt }));
      } catch {
        return [];
      }
    },
    async forget(tournamentId) {
      if (!usable) return;
      try {
        await store.deleteSnapshot(snapshotKey(owner, "tournament", tournamentId));
      } catch {
        /* ignore */
      }
    },
  };
}
