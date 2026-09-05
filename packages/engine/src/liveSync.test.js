import { describe, expect, test } from "vitest";
import {
  applyDeskRealtime,
  applyMatchIfScoped,
  isFresherRow,
  createCatchupBuffer,
  createSubscriptionTracker,
  deskLiveChannelName,
  liveHash,
  matchLiveChannelName,
  parseLiveHash,
  upsertById,
} from "./liveSync.js";

const tId = "11111111-1111-4111-8111-111111111111";
const m1 = "22222222-2222-4222-8222-222222222222";
const m2 = "33333333-3333-4333-8333-333333333333";

function desk(matches) {
  return { tournament: { id: tId }, matches, results: [], courtAssignments: [] };
}

describe("live hash routing", () => {
  test("parses a match-scoped live hash", () => {
    expect(parseLiveHash(liveHash(tId, m1))).toEqual({ tournamentId: tId, matchId: m1 });
    expect(parseLiveHash(`#/live/${tId}/${m1}`)).toEqual({ tournamentId: tId, matchId: m1 });
  });

  test("rejects a hash that is not a live match window", () => {
    expect(parseLiveHash("#/tournaments")).toBeNull();
    expect(parseLiveHash(`#/live/${tId}`)).toBeNull();
  });
});

describe("organizer live state machine", () => {
  test("match start updates organizer live state", () => {
    const before = desk([{ id: m1, tournament_id: tId, status: "assigned", score_state: { scoreA: 0, scoreB: 0 } }]);
    const after = applyDeskRealtime(before, "matches", "UPDATE", {
      id: m1,
      tournament_id: tId,
      status: "in_progress",
      score_state: { scoreA: 0, scoreB: 0, lastSeq: 0 },
    });
    expect(after.matches[0].status).toBe("in_progress");
  });

  test("score event updates live state", () => {
    const before = desk([{ id: m1, tournament_id: tId, status: "in_progress", score_state: { scoreA: 0, scoreB: 0, lastSeq: 0 } }]);
    const after = applyDeskRealtime(before, "matches", "UPDATE", {
      id: m1,
      tournament_id: tId,
      status: "in_progress",
      score_state: { scoreA: 1, scoreB: 0, lastSeq: 1 },
    });
    expect(after.matches[0].score_state.scoreA).toBe(1);
  });

  test("multiple score events update sequentially", () => {
    let data = desk([{ id: m1, tournament_id: tId, status: "in_progress", score_state: { scoreA: 0, scoreB: 0, lastSeq: 0 } }]);
    for (let i = 1; i <= 3; i += 1) {
      data = applyDeskRealtime(data, "matches", "UPDATE", {
        id: m1,
        tournament_id: tId,
        status: "in_progress",
        score_state: { scoreA: i, scoreB: 0, lastSeq: i },
      });
    }
    expect(data.matches[0].score_state.scoreA).toBe(3);
    expect(data.matches[0].score_state.lastSeq).toBe(3);
  });

  test("match completion updates LIVE to COMPLETED", () => {
    const before = desk([{ id: m1, tournament_id: tId, status: "in_progress", score_state: { status: "completed", winner: "A" } }]);
    const after = applyDeskRealtime(before, "matches", "UPDATE", {
      id: m1,
      tournament_id: tId,
      status: "completed",
      winner: "A",
      score_state: { status: "completed", winner: "A", scoreA: 11, scoreB: 7 },
    });
    expect(after.matches[0].status).toBe("completed");
  });

  test("ignores matches from another tournament", () => {
    const before = desk([{ id: m1, tournament_id: tId, status: "assigned" }]);
    const after = applyDeskRealtime(before, "matches", "UPDATE", {
      id: m2,
      tournament_id: "44444444-4444-4444-8444-444444444444",
      status: "in_progress",
    });
    expect(after.matches).toHaveLength(1);
    expect(after.matches[0].id).toBe(m1);
  });
});

describe("match-scoped live window", () => {
  test("does not display another match", () => {
    const current = { id: m1, score_state: { scoreA: 5, scoreB: 3 } };
    expect(applyMatchIfScoped(current, { id: m2, score_state: { scoreA: 9, scoreB: 1 } }, m1)).toEqual(current);
    expect(applyMatchIfScoped(current, { id: m1, score_state: { scoreA: 6, scoreB: 3 } }, m1).score_state.scoreA).toBe(6);
  });

  test("channel names are unique per window", () => {
    expect(matchLiveChannelName(m1)).not.toBe(matchLiveChannelName(m2));
    expect(deskLiveChannelName(tId)).toBe(`desk-live:${tId}`);
  });
});

describe("realtime subscription cleanup", () => {
  test("close removes the subscription; reopen is a single new subscription", () => {
    const tracker = createSubscriptionTracker();
    const unsubs = [];
    const open = () => {
      tracker.open("m1", () => {
        const handle = { unsubscribe() { unsubs.push("m1"); } };
        return handle;
      });
    };
    open();
    expect(tracker.count()).toBe(1);
    tracker.close("m1");
    expect(tracker.count()).toBe(0);
    expect(unsubs).toEqual(["m1"]);
    open();
    expect(tracker.count()).toBe(1);
    tracker.close("m1");
    expect(unsubs).toEqual(["m1", "m1"]);
  });

  test("two live windows coexist without sharing subscriptions", () => {
    const tracker = createSubscriptionTracker();
    tracker.open("m1", () => ({ unsubscribe() {} }));
    tracker.open("m2", () => ({ unsubscribe() {} }));
    expect(tracker.count()).toBe(2);
    tracker.close("m1");
    expect(tracker.has("m2")).toBe(true);
    expect(tracker.count()).toBe(1);
  });
});

describe("initial load + realtime race", () => {
  test("changes that arrive before load completes are applied after subscribe", () => {
    const buf = createCatchupBuffer();
    const applied = [];
    const handler = buf.wrap((row) => applied.push(row));
    handler({ id: m1, score_state: { scoreA: 1 } });
    handler({ id: m1, score_state: { scoreA: 2 } });
    expect(applied).toEqual([]);
    expect(buf.size).toBe(2);
    buf.markReady((row) => applied.push(row));
    expect(applied.map((r) => r.score_state.scoreA)).toEqual([1, 2]);
    handler({ id: m1, score_state: { scoreA: 3 } });
    expect(applied.at(-1).score_state.scoreA).toBe(3);
  });
});

describe("upsertById", () => {
  test("patches an existing row in place", () => {
    const rows = upsertById([{ id: m1, status: "assigned" }], { id: m1, status: "in_progress" });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("in_progress");
  });
});

describe("stale realtime rows", () => {
  test("isFresherRow rejects a lower lastSeq", () => {
    const current = { id: m1, score_state: { scoreA: 4, lastSeq: 4 }, updated_at: "2026-09-05T04:00:00.000Z" };
    const stale = { id: m1, score_state: { scoreA: 2, lastSeq: 2 }, updated_at: "2026-09-05T04:00:01.000Z" };
    expect(isFresherRow(current, stale)).toBe(false);
  });

  test("applyMatchIfScoped keeps the newer score", () => {
    const current = { id: m1, score_state: { scoreA: 4, lastSeq: 4 } };
    const stale = { id: m1, score_state: { scoreA: 1, lastSeq: 1 } };
    expect(applyMatchIfScoped(current, stale, m1).score_state.scoreA).toBe(4);
  });

  test("applyDeskRealtime ignores an older score replay", () => {
    const before = desk([{ id: m1, tournament_id: tId, status: "in_progress", score_state: { scoreA: 5, lastSeq: 5 } }]);
    const after = applyDeskRealtime(before, "matches", "UPDATE", {
      id: m1,
      tournament_id: tId,
      status: "in_progress",
      score_state: { scoreA: 1, lastSeq: 1 },
    });
    expect(after.matches[0].score_state.scoreA).toBe(5);
  });
});
