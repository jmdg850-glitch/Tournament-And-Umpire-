import { sendCommand } from "./index.js";
import { classifySendError } from "./offlineQueue.js";
import { laneOf, sortLaneEntries } from "./matchLane.js";

// One sync worker per app/profile. It replays a durable command queue
// (offlineQueue.js store) in per-match FIFO lanes, always with each entry's
// ORIGINAL command_id — the server's command_receipts / score_events.id
// idempotency makes a retry of an already-applied command a no-op.
//
// Rules (see docs design §8, §11):
//   - only entries owned by `owner` are ever sent; others are left untouched
//   - 2xx                → store.ack(): delete entry + record confirmed state atomically
//   - network / timeout  → keep, retry later with backoff (outcome unknown)
//   - 5xx / 408 / 429    → keep, retry later with backoff
//   - 401                → refresh auth once and retry; if that's impossible,
//                          stop and report `needsAuth` (entries kept, never a conflict)
//   - other 4xx          → mark that entry "conflict" (kept); its lane stops,
//                          other matches' lanes continue
//   - only ONE context per origin drains at a time (Web Locks, or a
//     localStorage lease where navigator.locks is unavailable)

export const DEFAULT_BACKOFF_MS = Object.freeze([2000, 5000, 15000, 30000, 60000]);
const LOCKED_RETRY_MS = 5000;

export function createStorageLease(key, { storage = safeLocalStorage(), ttlMs = 20000, now = () => Date.now(), holder = randomId() } = {}) {
  function read() {
    try {
      const raw = storage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function write() {
    storage.setItem(key, JSON.stringify({ holder, expiresAt: now() + ttlMs }));
  }
  return {
    holder,
    acquire() {
      if (!storage) return true; // nothing to coordinate through — single context assumed
      try {
        const cur = read();
        if (cur && cur.holder !== holder && cur.expiresAt > now()) return false;
        write();
        return read()?.holder === holder;
      } catch {
        return true;
      }
    },
    renew() {
      try {
        if (read()?.holder === holder) write();
      } catch {
        /* ignore */
      }
    },
    release() {
      try {
        if (read()?.holder === holder) storage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

function safeLocalStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `h-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
}

function defaultLocks() {
  try {
    return typeof navigator !== "undefined" && navigator.locks?.request ? navigator.locks : null;
  } catch {
    return null;
  }
}

function errorInfo(err, at) {
  return {
    status: err?.status ?? null,
    code: err?.code || (err?.timeout ? "TIMEOUT" : null),
    message: err?.message || "Unknown error",
    at,
  };
}

export function createSyncEngine({
  store,
  lockName,
  owner,
  getAuth,
  send = sendCommand,
  timeoutMs = 15000,
  onAck,
  backoffMs = DEFAULT_BACKOFF_MS,
  locks = defaultLocks(),
  lease = lockName ? createStorageLease(`${lockName}.lease`) : null,
  timers = globalThis,
  now = () => Date.now(),
}) {
  if (!store) throw new Error("createSyncEngine: a store is required");
  let running = false;
  let rerun = false;
  let stopped = false;
  let failures = 0;
  let timer = null;
  const listeners = new Set();
  let status = {
    owner,
    durable: store.durable !== false,
    syncing: false,
    offline: false,
    needsAuth: null,
    lockedElsewhere: false,
    lastError: null,
    lastSyncAt: null,
    nextRetryAt: null,
    pending: 0,
    conflicts: 0,
    unclaimed: 0,
    otherOwner: 0,
    byLane: {},
  };

  function emit() {
    for (const fn of listeners) {
      try {
        fn(status);
      } catch {
        /* a listener must never break syncing */
      }
    }
  }

  function setStatus(patch) {
    status = { ...status, ...patch };
    emit();
  }

  async function refreshStatus() {
    const all = await store.list();
    const byLane = {};
    let pending = 0;
    let conflicts = 0;
    let unclaimed = 0;
    let otherOwner = 0;
    for (const e of all) {
      if (e.status === "discarded") continue;
      if (!e.owner) { unclaimed += 1; continue; }
      if (e.owner !== owner) { otherOwner += 1; continue; }
      const lane = laneOf(e);
      byLane[lane] ||= { pending: 0, conflicts: 0 };
      if (e.status === "conflict") { conflicts += 1; byLane[lane].conflicts += 1; } else { pending += 1; byLane[lane].pending += 1; }
    }
    setStatus({ pending, conflicts, unclaimed, otherOwner, byLane });
    return status;
  }

  function schedule(ms) {
    if (stopped) return;
    if (timer) timers.clearTimeout(timer);
    setStatus({ nextRetryAt: now() + ms });
    timer = timers.setTimeout(() => {
      timer = null;
      run();
    }, ms);
  }

  function scheduleBackoff() {
    const ms = backoffMs[Math.min(failures, backoffMs.length - 1)];
    failures += 1;
    schedule(ms);
  }

  async function withLock(fn) {
    if (locks?.request) {
      return locks.request(lockName || "tournament-sync", { ifAvailable: true }, async (lock) => {
        if (!lock) return false;
        await fn();
        return true;
      });
    }
    if (lease) {
      if (!lease.acquire()) return false;
      const renew = timers.setInterval(() => lease.renew(), 5000);
      try {
        await fn();
        return true;
      } finally {
        timers.clearInterval(renew);
        lease.release();
      }
    }
    await fn();
    return true;
  }

  // Heads of every lane that can make progress right now.
  function nextSendable(all) {
    const lanes = new Map();
    for (const e of all) {
      if (e.status === "discarded" || e.owner !== owner) continue;
      const key = laneOf(e);
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(e);
    }
    const heads = [];
    for (const entries of lanes.values()) {
      const head = sortLaneEntries(entries)[0];
      if (head && head.status !== "conflict") heads.push(head);
    }
    heads.sort((a, b) => a.queuedAt - b.queuedAt);
    return heads[0] || null;
  }

  async function updateEntry(commandId, patch) {
    const cur = await store.get(commandId);
    if (!cur) return;
    await store.put({ ...cur, ...patch });
  }

  async function drainOnce() {
    let auth = await getAuth({ force: false });
    if (auth?.offline) {
      setStatus({ offline: true });
      scheduleBackoff();
      return;
    }
    if (!auth?.token) {
      setStatus({ needsAuth: auth?.message || "Sign in again to sync saved scores." });
      return;
    }
    setStatus({ needsAuth: null });
    let refreshed = false;
    for (;;) {
      if (stopped) return;
      const entry = nextSendable(await store.list());
      if (!entry) {
        failures = 0;
        setStatus({ offline: false, lastSyncAt: now(), nextRetryAt: null });
        return;
      }
      let body;
      try {
        body = await send({
          commandUrl: entry.commandUrl,
          accessToken: auth.token,
          publishableKey: entry.publishableKey,
          type: entry.type,
          payload: entry.payload,
          commandId: entry.command_id,
          timeoutMs,
        });
      } catch (err) {
        const kind = classifySendError(err);
        const at = now();
        if (kind === "auth") {
          if (!refreshed) {
            refreshed = true;
            auth = await getAuth({ force: true });
            if (auth?.token) continue; // retry the SAME entry with the new token
            if (auth?.offline) {
              setStatus({ offline: true });
              scheduleBackoff();
              return;
            }
          }
          await updateEntry(entry.command_id, { lastError: errorInfo(err, at) });
          setStatus({ needsAuth: auth?.message || "Your sign-in could not be verified. Sign in again to sync saved scores — they are kept on this device." });
          return;
        }
        if (kind === "network" || kind === "retry") {
          await updateEntry(entry.command_id, { attempts: (entry.attempts || 0) + 1, lastError: errorInfo(err, at) });
          setStatus({ offline: kind === "network", lastError: errorInfo(err, at) });
          scheduleBackoff();
          return;
        }
        await updateEntry(entry.command_id, { status: "conflict", attempts: (entry.attempts || 0) + 1, lastError: errorInfo(err, at) });
        setStatus({ lastError: errorInfo(err, at) });
        await refreshStatus();
        continue; // other matches' lanes keep going
      }
      let record;
      try {
        // sendCommand resolves to the response envelope {ok, idempotent, result};
        // onAck gets the command's own result (same shape for a first apply
        // and for an idempotent replay of a stored receipt).
        record = onAck ? await onAck(entry, body?.result ?? null, body) : null;
      } catch {
        // The server already accepted it: still ack the queue entry; the
        // confirmed context is refreshed by the next load instead.
        record = null;
      }
      await store.ack(entry.command_id, record);
      failures = 0;
      setStatus({ offline: false, lastError: null });
      await refreshStatus();
    }
  }

  async function run() {
    if (stopped) return;
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    if (timer) {
      timers.clearTimeout(timer);
      timer = null;
    }
    setStatus({ syncing: true });
    try {
      const got = await withLock(drainOnce);
      setStatus({ lockedElsewhere: !got });
      if (!got) schedule(LOCKED_RETRY_MS);
    } catch (err) {
      setStatus({ lastError: errorInfo(err, now()) });
      scheduleBackoff();
    } finally {
      running = false;
      setStatus({ syncing: false });
      try {
        await refreshStatus();
      } catch {
        /* ignore */
      }
      if (rerun && !stopped) {
        rerun = false;
        run();
      }
    }
  }

  async function mutateLane(laneId, fn) {
    const all = await store.list();
    for (const e of all) {
      if (e.owner !== owner || laneOf(e) !== laneId) continue;
      const next = fn(e);
      if (next) await store.put(next);
    }
    await refreshStatus();
  }

  return {
    get status() {
      return status;
    },
    subscribe(fn) {
      listeners.add(fn);
      fn(status);
      return () => listeners.delete(fn);
    },
    // Start (or restart) a sync pass now. `resetBackoff` is for explicit user
    // action / reconnect, where waiting out a long backoff makes no sense.
    kick({ resetBackoff = false } = {}) {
      if (resetBackoff) failures = 0;
      return run();
    },
    refreshStatus,
    // Put a conflicted lane back into play (e.g. a transient 403 was fixed).
    retryLane(laneId) {
      return mutateLane(laneId, (e) => (e.status === "conflict" ? { ...e, status: "pending", lastError: e.lastError } : null)).then(() => run());
    },
    // User-confirmed "keep the server's version": this lane's unsynced
    // entries are archived (status "discarded", kept on disk), never deleted.
    archiveLane(laneId) {
      return mutateLane(laneId, (e) => (e.status === "discarded" ? null : { ...e, status: "discarded", archivedAt: now(), archivedFrom: e.status || "pending" }));
    },
    // Entries written by an older app version carry no owner. They are only
    // sent after the signed-in user explicitly adopts them.
    async claimUnowned() {
      const all = await store.list();
      for (const e of all) {
        if (!e.owner && e.status !== "discarded") await store.put({ ...e, owner, status: e.status || "pending" });
      }
      await refreshStatus();
      return run();
    },
    // User-confirmed "don't send" for ownerless legacy entries: archived, not deleted.
    async archiveUnowned() {
      const all = await store.list();
      for (const e of all) {
        if (!e.owner && e.status !== "discarded") await store.put({ ...e, status: "discarded", archivedAt: now(), archivedFrom: e.status || "pending" });
      }
      await refreshStatus();
    },
    async pruneArchived(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
      const all = await store.list();
      const cutoff = now() - maxAgeMs;
      for (const e of all) {
        if (e.status === "discarded" && (e.archivedAt || 0) < cutoff) await store.delete(e.command_id);
      }
    },
    stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      listeners.clear();
    },
  };
}
