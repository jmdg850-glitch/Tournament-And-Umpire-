import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAttentionItems } from "./attention.js";

const tournaments = [
  { id: "t1", name: "Riverside Open" },
  { id: "t2", name: "Summer Slam" },
];

test("computeAttentionItems: no matches or devices means nothing needs attention", () => {
  assert.deepEqual(computeAttentionItems({ tournaments, matches: [], courtDevices: [] }), []);
});

test("computeAttentionItems: counts live and held matches per tournament, ignores normal statuses", () => {
  const matches = [
    { tournament_id: "t1", status: "in_progress" },
    { tournament_id: "t1", status: "in_progress" },
    { tournament_id: "t1", status: "postponed" },
    { tournament_id: "t1", status: "scheduled" },
    { tournament_id: "t1", status: "completed" },
    { tournament_id: "t2", status: "ready" },
  ];
  const items = computeAttentionItems({ tournaments, matches, courtDevices: [] });
  assert.deepEqual(items, [
    { tournamentId: "t1", tournamentName: "Riverside Open", live: 2, held: 1, courtsNeedRepairing: 0 },
  ]);
});

test("computeAttentionItems: a revoked device counts once per court, not if an active device replaced it", () => {
  const courtDevices = [
    { tournament_id: "t1", court_id: "c1", status: "revoked" },
    { tournament_id: "t1", court_id: "c1", status: "revoked" }, // same court, two revoked rows in history
    { tournament_id: "t1", court_id: "c2", status: "revoked" },
    { tournament_id: "t1", court_id: "c2", status: "active" }, // c2 was re-paired since
  ];
  const items = computeAttentionItems({ tournaments, matches: [], courtDevices });
  assert.deepEqual(items, [
    { tournamentId: "t1", tournamentName: "Riverside Open", live: 0, held: 0, courtsNeedRepairing: 1 },
  ]);
});

test("computeAttentionItems: sorts tournaments with more live matches first", () => {
  const matches = [
    { tournament_id: "t2", status: "in_progress" },
    { tournament_id: "t1", status: "in_progress" },
    { tournament_id: "t1", status: "in_progress" },
  ];
  const items = computeAttentionItems({ tournaments, matches, courtDevices: [] });
  assert.deepEqual(items.map((i) => i.tournamentId), ["t1", "t2"]);
});

test("computeAttentionItems: a deleted division's matches no longer count once the reload reflects the delete", () => {
  // Division deletion (delete_division) is a real, hard delete that cascades
  // to every match scoped to it (see packages/api/src/handleCommand.js's
  // handleDeleteDivision and the FK cascades in
  // supabase/migrations/0001_initial_schema.sql) — it does not set a
  // client-side "deleted" flag that this function would need to filter out.
  // So the contract this documents is: once TournamentDesk's load()/App.jsx's
  // reloadList() re-fetch `matches` from Postgres after a division delete,
  // the deleted division's matches are simply gone from the array passed in
  // here — this asserts that a live/held count computed before the delete
  // does not linger after that reload, the same way it wouldn't linger for
  // any other match that stopped existing.
  const beforeDelete = computeAttentionItems({
    tournaments,
    matches: [
      { tournament_id: "t1", status: "in_progress" },
      { tournament_id: "t1", status: "postponed" },
    ],
    courtDevices: [],
  });
  assert.deepEqual(beforeDelete, [
    { tournamentId: "t1", tournamentName: "Riverside Open", live: 1, held: 1, courtsNeedRepairing: 0 },
  ]);

  const afterDeleteAndReload = computeAttentionItems({ tournaments, matches: [], courtDevices: [] });
  assert.deepEqual(afterDeleteAndReload, []);
});

test("computeAttentionItems: falls back to a generic name if the tournament isn't in the given list", () => {
  const items = computeAttentionItems({
    tournaments: [],
    matches: [{ tournament_id: "unknown", status: "in_progress" }],
    courtDevices: [],
  });
  assert.equal(items[0].tournamentName, "Tournament");
});
