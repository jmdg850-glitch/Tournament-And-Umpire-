import { enqueueCommand } from "./offlineQueue.js";

// One "lane" per match: the single, authoritative place that allocates a
// match command's `seq` and durably records it BEFORE anything else happens.
//
//   allocate seq (synchronously) → persist to the store → (caller) show it →
//   (sync engine) send it
//
// Every match-scoped command the umpire can issue offline — point, undo,
// timeout, correction, coin toss, complete — goes through `enqueue`, so there
// is exactly one seq counter per match and no UI handler can mint its own.
// The server rejects seq <= lastSeq (packages/engine/src/scoring.js) and
// enforces unique(match_id, seq), so a reused seq would permanently wedge the
// queue; a skipped seq never happens because allocation is strictly +1.

const SCORE_EVENT_KINDS = new Set(["point", "undo", "timeout", "correction"]);
const ALL_KINDS = new Set([...SCORE_EVENT_KINDS, "coin_toss", "complete_match"]);

export function laneOf(entry) {
  return entry?.payload?.match_id || "global";
}

export function sortLaneEntries(entries) {
  return [...entries].sort((a, b) => (a.queuedAt - b.queuedAt) || ((a.payload?.seq ?? 0) - (b.payload?.seq ?? 0)));
}

function buildPayload(kind, matchId, eventId, seq, fields) {
  if (SCORE_EVENT_KINDS.has(kind)) {
    return { match_id: matchId, event_id: eventId, seq, type: kind, payload: fields || {} };
  }
  if (kind === "coin_toss") {
    return {
      match_id: matchId,
      event_id: eventId,
      seq,
      result: fields?.result,
      winner: fields?.winner,
      serving_team: fields?.serving_team,
      court_side: fields?.court_side,
    };
  }
  return { match_id: matchId };
}

function commandTypeOf(kind) {
  if (SCORE_EVENT_KINDS.has(kind)) return "score_event";
  return kind;
}

export function createMatchLane({
  store,
  matchId,
  owner,
  commandUrl,
  publishableKey,
  minRepeatMs = 400,
  now = () => Date.now(),
  newId = () => crypto.randomUUID(),
}) {
  let lastAllocated = 0;
  let persisting = false;
  let lastAccepted = null;

  return {
    matchId,
    get lastSeq() {
      return lastAllocated;
    },
    get busy() {
      return persisting;
    },
    // Raise the allocator to at least `seq` (confirmed server lastSeq, or the
    // highest seq already sitting in the queue). Never lowers it.
    observeSeq(seq) {
      const n = Number(seq);
      if (Number.isFinite(n) && n > lastAllocated) lastAllocated = n;
    },
    // Explicitly re-base the allocator (only after the user has resolved a
    // conflict and this device's unsynced backlog has been archived).
    reset(seq) {
      const n = Number(seq);
      lastAllocated = Number.isFinite(n) && n > 0 ? n : 0;
    },
    // `validate(commandPayload)` runs synchronously after seq allocation and
    // before persistence; it may return extra `local` data to store with the
    // entry (e.g. the resulting local score) or throw to refuse the command.
    async enqueue(kind, fields = {}, { validate } = {}) {
      if (!ALL_KINDS.has(kind)) throw new Error(`Unsupported match command: ${kind}`);
      // Correctness guard, not just UI: while one command is being written a
      // second one is refused, and an identical command repeated within
      // `minRepeatMs` is treated as an accidental double tap.
      if (persisting) return { accepted: false, reason: "busy" };
      const signature = `${kind}:${JSON.stringify(fields || {})}`;
      const at = now();
      if (lastAccepted && lastAccepted.signature === signature && at - lastAccepted.at < minRepeatMs) {
        return { accepted: false, reason: "duplicate_tap" };
      }
      persisting = true;
      const usesSeq = kind !== "complete_match";
      const previous = lastAllocated;
      const seq = usesSeq ? lastAllocated + 1 : undefined;
      if (usesSeq) lastAllocated = seq;
      const eventId = newId();
      const payload = buildPayload(kind, matchId, eventId, seq, fields);
      try {
        let local;
        try {
          local = validate ? validate(payload) : undefined;
        } catch (err) {
          lastAllocated = previous;
          return { accepted: false, reason: "invalid", error: err };
        }
        let entry;
        try {
          entry = await enqueueCommand(store, {
            command_id: eventId,
            type: commandTypeOf(kind),
            payload,
            owner,
            commandUrl,
            publishableKey,
            local,
          });
        } catch (err) {
          // Nothing was persisted: hand the seq back so the next command
          // doesn't leave a gap, and tell the caller NOT to show the change.
          if (usesSeq && lastAllocated === seq) lastAllocated = previous;
          return { accepted: false, reason: "persist_failed", error: err };
        }
        lastAccepted = { signature, at };
        return { accepted: true, entry };
      } finally {
        persisting = false;
      }
    },
  };
}

// Deterministic local view of one match:
//   confirmed server state (baseMatch) + this device's unsynced commands.
// After a restart the exact same view is rebuilt from disk.
//
// `applyEntry(match, entry)` returns the next match (throws if the entry can't
// be applied). Entries whose event id the confirmed state already contains
// were accepted by the server (e.g. the response was lost) and are skipped.
// An entry whose seq is not beyond the running lastSeq means the server
// advanced independently (another device / an organizer): it and everything
// after it in this lane are "blocked" — kept, never applied, never dropped.
export function reconstructMatchView({ baseMatch, entries, applyEntry }) {
  const lane = sortLaneEntries((entries || []).filter((e) => e.status !== "discarded"));
  const baseState = baseMatch?.score_state || {};
  const baseSeq = Number(baseState.lastSeq || 0);
  const confirmedIds = new Set(baseState.appliedEventIds || []);
  let match = baseMatch;
  const pending = [];
  const conflicts = [];
  const blocked = [];
  const alreadyApplied = [];
  let diverged = false;
  let localLastSeq = baseSeq;

  for (const entry of lane) {
    const seq = entry.payload?.seq;
    if (typeof seq === "number" && seq > localLastSeq) localLastSeq = seq;
    const eventId = entry.payload?.event_id;
    if (eventId && confirmedIds.has(eventId)) {
      alreadyApplied.push(entry);
      continue;
    }
    if (entry.status === "conflict") {
      conflicts.push(entry);
      diverged = true;
      continue;
    }
    if (diverged || !match) {
      blocked.push(entry);
      continue;
    }
    const running = Number(match?.score_state?.lastSeq || 0);
    if (typeof seq === "number" && seq <= running) {
      diverged = true;
      blocked.push(entry);
      continue;
    }
    try {
      match = applyEntry(match, entry);
      pending.push(entry);
    } catch {
      diverged = true;
      blocked.push(entry);
    }
  }

  return {
    match,
    pending,
    conflicts,
    blocked,
    alreadyApplied,
    diverged,
    localLastSeq,
    unsynced: pending.length + conflicts.length + blocked.length,
  };
}
