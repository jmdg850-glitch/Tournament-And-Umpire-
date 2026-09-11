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

export function createMemoryStore() {
  const rows = new Map();
  return {
    async put(entry) {
      rows.set(entry.command_id, entry);
    },
    async delete(command_id) {
      rows.delete(command_id);
    },
    async list() {
      return [...rows.values()].sort((a, b) => a.queuedAt - b.queuedAt);
    },
  };
}

const DB_VERSION = 1;
const STORE_NAME = "commands";

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
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(mode, fn) {
    const db = await openDB();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const result = fn(store);
        tx.oncomplete = () => resolve(result?.value);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  return {
    async put(entry) {
      await withStore("readwrite", (store) => {
        store.put(entry);
      });
    },
    async delete(command_id) {
      await withStore("readwrite", (store) => {
        store.delete(command_id);
      });
    },
    async list() {
      const holder = {};
      await withStore("readonly", (store) => {
        const req = store.getAll();
        req.onsuccess = () => {
          holder.value = (req.result || []).sort((a, b) => a.queuedAt - b.queuedAt);
        };
      });
      return holder.value || [];
    },
  };
}

// Best-effort: falls back to an in-memory store (queue does not survive a
// reload, but the app still works exactly as it does today — no regression)
// if IndexedDB is unavailable for any reason.
export function defaultStore(dbName) {
  return createIndexedDBStore(dbName) || createMemoryStore();
}

// Drop-in replacement for `sendCommand`: on a real network failure the
// command is persisted to `store` (keyed by its own idempotent command_id)
// and a `{ok:true, queued:true}` sentinel is returned instead of throwing,
// so callers that already apply an optimistic local update (umpire scoring,
// operator commands) can keep that update on screen instead of rolling it
// back. Any error that reached the server (auth, validation, lifecycle,
// conflict) is rethrown unchanged — existing error handling is untouched.
export async function sendCommandDurable({ store, send = sendCommand, commandUrl, accessToken, publishableKey, type, payload, commandId }) {
  const command_id = commandId || crypto.randomUUID();
  try {
    return await send({ commandUrl, accessToken, publishableKey, type, payload, commandId: command_id });
  } catch (err) {
    if (!isNetworkError(err) || !store) throw err;
    await store.put({ command_id, type, payload, commandUrl, publishableKey, queuedAt: Date.now() });
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
