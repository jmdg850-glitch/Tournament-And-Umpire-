const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

export function parseLiveHash(hash) {
  const h = String(hash || "").replace(/^#/, "");
  const m = h.match(/^\/?live\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i);
  if (!m) return null;
  return { tournamentId: m[1], matchId: m[2] };
}

export function liveHash(tournamentId, matchId) {
  return `#/live/${tournamentId}/${matchId}`;
}

export function deskLiveChannelName(tournamentId) {
  return `desk-live:${tournamentId}`;
}

export function matchLiveChannelName(matchId) {
  return `live-match:${matchId}`;
}

function lastSeqOf(row) {
  const n = Number(row?.score_state?.lastSeq);
  return Number.isFinite(n) ? n : null;
}

function updatedAtMs(row) {
  const t = Date.parse(row?.updated_at || "");
  return Number.isFinite(t) ? t : null;
}

export function isFresherRow(current, incoming) {
  if (!incoming) return false;
  if (!current) return true;
  const currentSeq = lastSeqOf(current);
  const incomingSeq = lastSeqOf(incoming);
  if (currentSeq != null && incomingSeq != null && incomingSeq < currentSeq) return false;
  if (incomingSeq != null && currentSeq != null && incomingSeq > currentSeq) return true;
  const currentAt = updatedAtMs(current);
  const incomingAt = updatedAtMs(incoming);
  if (currentAt != null && incomingAt != null && incomingAt < currentAt) return false;
  return true;
}

export function upsertById(rows, row, idKey = "id") {
  if (!row?.[idKey]) return rows || [];
  const list = rows || [];
  const i = list.findIndex((r) => r[idKey] === row[idKey]);
  if (i < 0) return [...list, row];
  if (!isFresherRow(list[i], row)) return list;
  const next = list.slice();
  next[i] = { ...next[i], ...row };
  return next;
}

export function removeById(rows, id, idKey = "id") {
  return (rows || []).filter((r) => r[idKey] !== id);
}

export function applyMatchIfScoped(current, incoming, matchId) {
  if (!incoming || incoming.id !== matchId) return current;
  if (!current) return incoming;
  if (!isFresherRow(current, incoming)) return current;
  return { ...current, ...incoming };
}

export function applyDeskRealtime(data, table, eventType, row, oldRow) {
  if (!data) return data;
  const tournamentId = data.tournament?.id;
  if (table === "matches") {
    const id = row?.id || oldRow?.id;
    if (row?.tournament_id && tournamentId && row.tournament_id !== tournamentId) return data;
    if (oldRow?.tournament_id && tournamentId && oldRow.tournament_id !== tournamentId) return data;
    if (eventType === "DELETE") {
      return { ...data, matches: removeById(data.matches, id) };
    }
    if (!row) return data;
    return { ...data, matches: upsertById(data.matches, row) };
  }
  if (table === "match_results") {
    const id = row?.id || oldRow?.id;
    const matchId = row?.match_id || oldRow?.match_id;
    if (matchId && tournamentId && !(data.matches || []).some((m) => m.id === matchId)) return data;
    if (eventType === "DELETE") {
      return { ...data, results: removeById(data.results, id) };
    }
    if (!row) return data;
    return { ...data, results: upsertById(data.results, row) };
  }
  if (table === "court_assignments") {
    const id = row?.id || oldRow?.id;
    const matchId = row?.match_id || oldRow?.match_id;
    if (matchId && !(data.matches || []).some((m) => m.id === matchId)) return data;
    if (eventType === "DELETE") {
      return { ...data, courtAssignments: removeById(data.courtAssignments, id) };
    }
    if (!row) return data;
    return { ...data, courtAssignments: upsertById(data.courtAssignments, row) };
  }
  return data;
}

export function createCatchupBuffer() {
  const pending = [];
  let ready = false;
  return {
    wrap(handler) {
      return (payload) => {
        if (!ready) pending.push(payload);
        else handler(payload);
      };
    },
    markReady(handler) {
      ready = true;
      const queued = pending.splice(0, pending.length);
      for (const payload of queued) handler(payload);
    },
    get size() {
      return pending.length;
    },
    get ready() {
      return ready;
    },
    reset() {
      ready = false;
      pending.length = 0;
    },
  };
}

export function createSubscriptionTracker() {
  const active = new Map();
  return {
    open(key, subscribeFn) {
      this.close(key);
      const handle = subscribeFn();
      active.set(key, handle);
      return handle;
    },
    close(key) {
      const handle = active.get(key);
      if (handle && typeof handle.unsubscribe === "function") handle.unsubscribe();
      active.delete(key);
    },
    closeAll() {
      for (const key of [...active.keys()]) this.close(key);
    },
    count() {
      return active.size;
    },
    has(key) {
      return active.has(key);
    },
  };
}
