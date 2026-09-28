import { sendCommand } from "./index.js";

// A queued command has reached the network layer and failed before any HTTP
// response was received (offline, DNS failure, connection refused, timeout).
// `sendCommand` only sets `err.status` once a response actually comes back
// from the server, so the absence of `err.status` is the exact signal that
// the command never reached the server and is therefore safe to queue and
// replay later — a real server rejection (4xx/5xx) always has `err.status`
// and must never be queued, since replaying it would just fail again the
// same way (or worse, mask a real authorization/validation error).
export function isNetworkError(err) {
  return Boolean(err) && err.status == null;
}

// How a failed send must be treated by anything replaying the queue:
//   "network"  — never answered (offline, DNS, timeout). Outcome unknown: keep
//                the entry and retry the SAME command_id later.
//   "auth"     — 401. The credential expired/was rejected; refresh and retry.
//                Never a conflict.
//   "retry"    — 5xx / 408 / 429. The server may or may not have applied it;
//                retrying the same command_id is idempotent server-side.
//   "rejected" — any other 4xx: the server actively refused this command
//                against its current state. Keep it, surface it, never drop.
export function classifySendError(err) {
  if (!err) return "network";
  if (err.status == null) return "network";
  const status = Number(err.status);
  if (status === 401) return "auth";
  if (status >= 500 || status === 408 || status === 429) return "retry";
  return "rejected";
}

// Queue entries carry the identity that created them ("user:<uuid>" or
// "station:<device id>") so a queue is never replayed under a different
// signed-in user or a different court pairing on the same device.
export function ownerKey(kind, id) {
  return kind && id ? `${kind}:${id}` : null;
}

function seqOf(match) {
  const n = Number(match?.score_state?.lastSeq);
  return Number.isFinite(n) ? n : 0;
}

// Confirmed (server-acknowledged) match context is only ever moved FORWARD:
// a stale fetch or an old idempotent receipt with a lower lastSeq can refresh
// the display context (names, court) but never roll the confirmed score back.
export function mergeConfirmedRecord(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const keepExistingMatch = incoming.match && existing.match && seqOf(incoming.match) < seqOf(existing.match);
  return {
    ...existing,
    ...incoming,
    match: keepExistingMatch ? existing.match : (incoming.match || existing.match),
    sides: incoming.sides ?? existing.sides,
    participants: incoming.participants ?? existing.participants,
    court: incoming.court !== undefined ? incoming.court : existing.court,
  };
}

// Snapshots (offline tournament packages) only ever move FORWARD in time: a
// slow, stale load finishing late can never overwrite a newer saved copy.
export function mergeSnapshot(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return Number(incoming.savedAt || 0) >= Number(existing.savedAt || 0) ? incoming : existing;
}

export function createMemoryStore() {
  const rows = new Map();
  const matches = new Map();
  const snapshots = new Map();
  return {
    durable: false,
    async put(entry) {
      rows.set(entry.command_id, entry);
    },
    async get(command_id) {
      return rows.get(command_id) || null;
    },
    async delete(command_id) {
      rows.delete(command_id);
    },
    async list() {
      return [...rows.values()].sort((a, b) => a.queuedAt - b.queuedAt);
    },
    async putMatch(record) {
      matches.set(record.matchId, mergeConfirmedRecord(matches.get(record.matchId), record));
    },
    async getMatch(matchId) {
      return matches.get(matchId) || null;
    },
    async listMatches() {
      return [...matches.values()];
    },
    async deleteMatch(matchId) {
      matches.delete(matchId);
    },
    async ack(command_id, record) {
      rows.delete(command_id);
      if (record) matches.set(record.matchId, mergeConfirmedRecord(matches.get(record.matchId), record));
    },
    async putSnapshot(snapshot) {
      snapshots.set(snapshot.key, mergeSnapshot(snapshots.get(snapshot.key), snapshot));
    },
    async getSnapshot(key) {
      return snapshots.get(key) || null;
    },
    async listSnapshots() {
      return [...snapshots.values()];
    },
    async deleteSnapshot(key) {
      snapshots.delete(key);
    },
  };
}

// v2 adds the "matches" store (confirmed match context for offline resume).
// v3 adds the "snapshots" store (offline tournament packages, see
// localRepository.js). Each upgrade is additive: earlier stores and every
// entry in them are kept as-is.
const DB_VERSION = 3;
const STORE_NAME = "commands";
const MATCH_STORE = "matches";
const SNAPSHOT_STORE = "snapshots";

export function createIndexedDBStore(dbName) {
  if (typeof indexedDB === "undefined") return null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "command_id" });
        }
        if (!db.objectStoreNames.contains(MATCH_STORE)) {
          db.createObjectStore(MATCH_STORE, { keyPath: "matchId" });
        }
        if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
          db.createObjectStore(SNAPSHOT_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another window upgrading the schema must never be blocked by us.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Writes ask for "strict" durability (flushed to disk before oncomplete)
  // where the browser supports it; older engines ignore/omit the option.
  function transaction(db, names, mode) {
    if (mode === "readwrite") {
      try {
        return db.transaction(names, mode, { durability: "strict" });
      } catch {
        // option unsupported — fall through
      }
    }
    return db.transaction(names, mode);
  }

  async function withStores(names, mode, fn) {
    const db = await openDB();
    try {
      return await new Promise((resolve, reject) => {
        const tx = transaction(db, names, mode);
        const holder = {};
        fn(tx, holder);
        tx.oncomplete = () => resolve(holder.value);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
      });
    } finally {
      db.close();
    }
  }

  function getAllInto(store, holder, sort) {
    const req = store.getAll();
    req.onsuccess = () => {
      const rows = req.result || [];
      holder.value = sort ? rows.sort(sort) : rows;
    };
  }

  function mergePut(store, record) {
    const req = store.get(record.matchId);
    req.onsuccess = () => {
      store.put(mergeConfirmedRecord(req.result || null, record));
    };
  }

  return {
    durable: true,
    async put(entry) {
      await withStores(STORE_NAME, "readwrite", (tx) => {
        tx.objectStore(STORE_NAME).put(entry);
      });
    },
    async get(command_id) {
      return withStores(STORE_NAME, "readonly", (tx, holder) => {
        const req = tx.objectStore(STORE_NAME).get(command_id);
        req.onsuccess = () => { holder.value = req.result || null; };
      });
    },
    async delete(command_id) {
      await withStores(STORE_NAME, "readwrite", (tx) => {
        tx.objectStore(STORE_NAME).delete(command_id);
      });
    },
    async list() {
      const rows = await withStores(STORE_NAME, "readonly", (tx, holder) => {
        getAllInto(tx.objectStore(STORE_NAME), holder, (a, b) => a.queuedAt - b.queuedAt);
      });
      return rows || [];
    },
    async putMatch(record) {
      await withStores(MATCH_STORE, "readwrite", (tx) => {
        mergePut(tx.objectStore(MATCH_STORE), record);
      });
    },
    async getMatch(matchId) {
      return withStores(MATCH_STORE, "readonly", (tx, holder) => {
        const req = tx.objectStore(MATCH_STORE).get(matchId);
        req.onsuccess = () => { holder.value = req.result || null; };
      });
    },
    async listMatches() {
      const rows = await withStores(MATCH_STORE, "readonly", (tx, holder) => {
        getAllInto(tx.objectStore(MATCH_STORE), holder);
      });
      return rows || [];
    },
    async deleteMatch(matchId) {
      await withStores(MATCH_STORE, "readwrite", (tx) => {
        tx.objectStore(MATCH_STORE).delete(matchId);
      });
    },
    // Server acknowledgement, atomically: the command leaves the queue in the
    // SAME transaction that records its confirmed result, so a crash can never
    // leave "command gone but confirmed score not advanced" (which would let
    // the seq allocator hand out an already-used seq after a restart).
    async ack(command_id, record) {
      await withStores([STORE_NAME, MATCH_STORE], "readwrite", (tx) => {
        tx.objectStore(STORE_NAME).delete(command_id);
        if (record) mergePut(tx.objectStore(MATCH_STORE), record);
      });
    },
    async putSnapshot(snapshot) {
      await withStores(SNAPSHOT_STORE, "readwrite", (tx) => {
        const store = tx.objectStore(SNAPSHOT_STORE);
        const req = store.get(snapshot.key);
        req.onsuccess = () => {
          store.put(mergeSnapshot(req.result || null, snapshot));
        };
      });
    },
    async getSnapshot(key) {
      return withStores(SNAPSHOT_STORE, "readonly", (tx, holder) => {
        const req = tx.objectStore(SNAPSHOT_STORE).get(key);
        req.onsuccess = () => { holder.value = req.result || null; };
      });
    },
    async listSnapshots() {
      const rows = await withStores(SNAPSHOT_STORE, "readonly", (tx, holder) => {
        getAllInto(tx.objectStore(SNAPSHOT_STORE), holder);
      });
      return rows || [];
    },
    async deleteSnapshot(key) {
      await withStores(SNAPSHOT_STORE, "readwrite", (tx) => {
        tx.objectStore(SNAPSHOT_STORE).delete(key);
      });
    },
  };
}

// Best-effort: falls back to an in-memory store (queue does not survive a
// reload) if IndexedDB is unavailable for any reason. Such a store reports
// `durable: false` so the UI can warn that scores are NOT being kept on disk.
export function defaultStore(dbName) {
  return createIndexedDBStore(dbName) || createMemoryStore();
}

// Write-ahead persistence of one command: the returned promise resolves only
// once the entry is committed to `store`. Callers must not show the change or
// attempt the network until it resolves. `queuedAt` is strictly increasing
// within this JS realm so same-millisecond commands keep their order.
let lastQueuedAt = 0;
export async function enqueueCommand(store, { command_id, type, payload, owner, commandUrl, publishableKey, local }) {
  if (!store) throw new Error("enqueueCommand: a store is required");
  const queuedAt = Math.max(Date.now(), lastQueuedAt + 1);
  lastQueuedAt = queuedAt;
  const entry = {
    command_id,
    type,
    payload,
    commandUrl,
    publishableKey,
    queuedAt,
    owner: owner || null,
    status: "pending",
    attempts: 0,
    lastError: null,
    ...(local ? { local } : {}),
  };
  await store.put(entry);
  return entry;
}

// Drop-in replacement for `sendCommand`: on a real network failure the
// command is persisted to `store` (keyed by its own idempotent command_id)
// and a `{ok:true, queued:true}` sentinel is returned instead of throwing,
// so callers that already apply an optimistic local update (umpire scoring,
// operator commands) can keep that update on screen instead of rolling it
// back. Any error that reached the server (auth, validation, lifecycle,
// conflict) is rethrown unchanged — existing error handling is untouched.
//
// `forceQueue: true` skips the live-send attempt entirely and queues
// immediately. Callers must pass this whenever an earlier command for the
// same resource (e.g. the same match's score_events) is still sitting
// undrained in `store`: on a flaky ("network flapping") connection, a later
// command can otherwise slip through live while an earlier one is still
// queued, creating a gap in a strictly-ordered sequence (like score_event's
// seq) — the server's OUT_OF_ORDER check only rejects seq <= lastSeq, not a
// skipped seq, so a gap isn't caught until the earlier, now-stale queued
// command is finally replayed and permanently rejected. Forcing every
// command behind an already-nonempty per-resource queue to also queue keeps
// replay strictly FIFO and gap-free.
export async function sendCommandDurable({ store, send = sendCommand, commandUrl, accessToken, publishableKey, type, payload, commandId, forceQueue = false, owner }) {
  const command_id = commandId || crypto.randomUUID();
  const entry = () => ({ command_id, type, payload, commandUrl, publishableKey, queuedAt: Date.now(), ...(owner ? { owner } : {}) });
  if (forceQueue) {
    if (!store) throw new Error("sendCommandDurable: forceQueue requires a store");
    await store.put(entry());
    return { ok: true, queued: true, command_id };
  }
  try {
    return await send({ commandUrl, accessToken, publishableKey, type, payload, commandId: command_id });
  } catch (err) {
    if (!isNetworkError(err) || !store) throw err;
    await store.put(entry());
    return { ok: true, queued: true, command_id };
  }
}

// Replays queued commands in the exact order they were queued (FIFO), using
// each command's original command_id — the server's existing command_receipts
// idempotency check (packages/api/src/handleCommand.js) guarantees a command
// already applied before the connection dropped is never double-applied, it
// just returns the prior receipt. Replay stops at the first command that is
// still unreachable (still offline — try again on the next trigger) or that
// the server actively rejects (a real conflict/validation error — e.g. the
// match was completed by another device while this one was offline); later
// queued commands are left in place, in order, rather than skipped ahead of
// a failed one, since these are sequential match/score mutations. This is
// not a new conflict-resolution rule — a rejected replay surfaces the exact
// same error the system already produces for that command today.
//
// The server's command_receipts check is read-then-write (existingReceipt()
// is a plain SELECT, the receipt row is only written once the handler has
// finished), so two genuinely concurrent replays of the same command_id can
// both pass the check and both apply — a live browser test caught exactly
// this (two "online"/interval-triggered drains overlapping produced two
// courts from one queued create_court). That race is pre-existing server
// behavior this session did not change (see CLAUDE.md's database-protection
// rule) and is only reachable at all now that a client can genuinely retry a
// command; the fix here is the inFlight guard below, which makes it
// impossible for THIS client to ever have two replays of its own outbox in
// flight at once, which is the only way multiple callers (an 'online' event,
// the fallback interval, and an effect re-run all firing close together) can
// trigger it from a single device.
const inFlight = new WeakSet();

export async function drainQueue({ store, send = sendCommand, getAccessToken, publishableKey, onEach }) {
  if (!store) return { drained: 0, remaining: 0, stoppedOn: null };
  if (inFlight.has(store)) return { drained: 0, remaining: 0, stoppedOn: "already_draining" };
  inFlight.add(store);
  try {
    const queued = await store.list();
    let drained = 0;
    for (const entry of queued) {
      const accessToken = await getAccessToken();
      if (!accessToken) return { drained, remaining: queued.length - drained, stoppedOn: "no_token" };
      try {
        const result = await send({
          commandUrl: entry.commandUrl,
          accessToken,
          publishableKey: entry.publishableKey || publishableKey,
          type: entry.type,
          payload: entry.payload,
          commandId: entry.command_id,
        });
        await store.delete(entry.command_id);
        drained += 1;
        onEach?.(entry, result, null);
      } catch (err) {
        onEach?.(entry, null, err);
        return { drained, remaining: queued.length - drained, stoppedOn: isNetworkError(err) ? "offline" : "rejected" };
      }
    }
    return { drained, remaining: 0, stoppedOn: null };
  } finally {
    inFlight.delete(store);
  }
}

export async function queueSize(store) {
  if (!store) return 0;
  return (await store.list()).length;
}
