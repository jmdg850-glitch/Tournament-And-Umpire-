// Organizer rename of a player (update_person), through the real
// handleCommand() with an in-memory admin (same shape as matchOutcome.test.js).
// The canonical persons row changes, and every entry (participant) whose name
// was built from that player's name follows in the same transaction, so match,
// bracket, umpire and export views — which show the entry name — all agree.
import { describe, expect, test } from "vitest";
import { handleCommand } from "./handleCommand.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

function createMemoryAdmin(seed) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const table = (name) => (tables[name] ||= []);
  function query(name) {
    const filters = [];
    const run = () => table(name).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
    const builder = {
      select() { return builder; },
      eq(col, v) { filters.push((r) => r[col] === v); return builder; },
      in(col, vs) { const s = new Set(vs); filters.push((r) => s.has(r[col])); return builder; },
      is(col, v) { filters.push((r) => (r[col] ?? null) === v); return builder; },
      order() { return builder; },
      limit() { return builder; },
      async maybeSingle() { await tick(); return { data: run()[0] ?? null, error: null }; },
      async single() { await tick(); return { data: run()[0] ?? null, error: null }; },
      then(resolve, reject) { return tick().then(() => ({ data: run(), error: null })).then(resolve, reject); },
    };
    return builder;
  }
  return {
    tables,
    from: (name) => query(name),
    async rpc(fn, { payload }) {
      await tick();
      for (const [name, rows] of Object.entries(payload.upserts || {})) {
        for (const row of rows) {
          const list = table(name);
          const i = list.findIndex((r) => r.id === row.id);
          if (i >= 0) list[i] = { ...list[i], ...row }; else list.push({ ...row });
        }
      }
      return { data: {}, error: null };
    },
  };
}

const T = "tournament-rn";
const D1 = "division-mixed";
const D2 = "division-open";
const TS = "2026-10-01T00:00:00.000Z";
const ORGANIZER = { kind: "user", id: "organizer-1", email: "organizer@example.com" };
const UMPIRE = { kind: "user", id: "umpire-1", email: "umpire@example.com" };
const STRANGER = { kind: "user", id: "stranger-1", email: "x@example.com" };
const STATION = { kind: "station", id: "dev-1", deviceId: "dev-1", courtId: "c-1", tournamentId: T };
const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";
const ANA2 = "33333333-3333-4333-8333-333333333333"; // a different player, also named "Ana Cruz"
const CY = "44444444-4444-4444-8444-444444444444";

function fixture() {
  const person = (id, display_name) => ({ id, tournament_id: T, display_name, user_id: null, created_at: TS });
  const entry = (id, division_id, kind, display_name) => ({ id, tournament_id: T, division_id, kind, team_id: null, seed: null, display_name, created_at: TS });
  const member = (participant_id, person_id, slot) => ({ id: `${participant_id}-${person_id}`, participant_id, person_id, slot });
  return createMemoryAdmin({
    tournaments: [{ id: T, name: "Open", status: "live" }],
    tournament_members: [
      { id: "tm-o", tournament_id: T, user_id: ORGANIZER.id, role: "organizer" },
      { id: "tm-u", tournament_id: T, user_id: UMPIRE.id, role: "umpire" },
    ],
    licenses: [{ id: "lic-1", email: ORGANIZER.email, status: "active", expires_at: null, created_at: TS }],
    persons: [person(ANA, "Ana Cruz"), person(BEN, "Ben Lim"), person(ANA2, "Ana Cruz"), person(CY, "Cy Tan")],
    participants: [
      entry("e-single", D2, "singles", "Ana Cruz"), // Ana, singles in Open
      entry("e-pair", D1, "doubles", "Ana Cruz / Ben Lim"), // Ana + Ben in Mixed
      entry("e-rev", D2, "doubles", "Ben Lim / Ana Cruz"), // Ana(slot 1) + Ben, registered name in the other order
      entry("e-custom", D1, "team_pair", "The Smashers"), // custom label: never rewritten
      entry("e-ana2", D1, "doubles", "Ana Cruz / Cy Tan"), // the OTHER Ana Cruz
    ],
    participant_members: [
      member("e-single", ANA, 1),
      member("e-pair", ANA, 1), member("e-pair", BEN, 2),
      member("e-rev", ANA, 1), member("e-rev", BEN, 2),
      member("e-custom", ANA, 1), member("e-custom", CY, 2),
      member("e-ana2", ANA2, 1), member("e-ana2", CY, 2),
    ],
    match_participants: [{ id: "mp-1", match_id: "m-1", slot: "A", participant_id: "e-pair", team_id: null }],
    command_receipts: [],
    audit_logs: [],
  });
}

const send = (admin, actor, payload) =>
  handleCommand({ admin, actor, body: { command_id: crypto.randomUUID(), type: "update_person", payload } });
const fail = (p) => p.then(() => { throw new Error("unexpectedly succeeded"); }, (e) => e);
const entryName = (admin, id) => admin.tables.participants.find((p) => p.id === id).display_name;
const personName = (admin, id) => admin.tables.persons.find((p) => p.id === id).display_name;

describe("update_person: system-wide rename", () => {
  test("renames the player and every entry built from the name, in every division; custom labels are kept", async () => {
    const admin = fixture();
    const res = await send(admin, ORGANIZER, { person_id: ANA, display_name: "  Anna   Cruz ", expected_display_name: "Ana Cruz" });
    expect(res.ok).toBe(true);
    expect(personName(admin, ANA)).toBe("Anna Cruz");
    expect(entryName(admin, "e-single")).toBe("Anna Cruz");
    expect(entryName(admin, "e-pair")).toBe("Anna Cruz / Ben Lim");
    expect(entryName(admin, "e-rev")).toBe("Ben Lim / Anna Cruz");
    expect(entryName(admin, "e-custom")).toBe("The Smashers");
    expect(res.result.renamed_participants.sort()).toEqual(["e-pair", "e-rev", "e-single"]);
    expect(res.result.skipped_participants).toEqual(["e-custom"]);
    const audit = admin.tables.audit_logs.at(-1);
    expect(audit.command_type).toBe("update_person");
    expect(audit.detail.rename_person).toMatchObject({ person_id: ANA, from: "Ana Cruz", to: "Anna Cruz" });
  });

  test("ids, memberships and match slots are untouched; a different player with the same name is not affected or merged", async () => {
    const admin = fixture();
    const before = JSON.stringify({ pm: admin.tables.participant_members, mp: admin.tables.match_participants });
    await send(admin, ORGANIZER, { person_id: ANA, display_name: "Anna Cruz" });
    expect(JSON.stringify({ pm: admin.tables.participant_members, mp: admin.tables.match_participants })).toBe(before);
    expect(admin.tables.persons.map((p) => p.id).sort()).toEqual([ANA, BEN, ANA2, CY].sort());
    expect(personName(admin, ANA2)).toBe("Ana Cruz");
    expect(entryName(admin, "e-ana2")).toBe("Ana Cruz / Cy Tan");
    expect(admin.tables.participants.map((p) => p.id).sort()).toEqual(["e-ana2", "e-custom", "e-pair", "e-rev", "e-single"]);
  });

  test("renaming to a name another player already has keeps them separate", async () => {
    const admin = fixture();
    await send(admin, ORGANIZER, { person_id: CY, display_name: "Ben Lim" });
    expect(admin.tables.persons.filter((p) => p.display_name === "Ben Lim").map((p) => p.id).sort()).toEqual([BEN, CY].sort());
    expect(entryName(admin, "e-ana2")).toBe("Ana Cruz / Ben Lim");
    expect(entryName(admin, "e-pair")).toBe("Ana Cruz / Ben Lim");
  });

  test("a stale screen (expected name no longer current) is refused and nothing changes", async () => {
    const admin = fixture();
    await send(admin, ORGANIZER, { person_id: ANA, display_name: "Anna Cruz", expected_display_name: "Ana Cruz" });
    const err = await fail(send(admin, ORGANIZER, { person_id: ANA, display_name: "Ana Kruz", expected_display_name: "Ana Cruz" }));
    expect([err.status, err.code]).toEqual([409, "STALE_STATE"]);
    expect(personName(admin, ANA)).toBe("Anna Cruz");
    expect(entryName(admin, "e-single")).toBe("Anna Cruz");
  });

  test("an empty or whitespace-only name is rejected", async () => {
    const admin = fixture();
    for (const display_name of ["", "   ", null]) {
      const err = await fail(send(admin, ORGANIZER, { person_id: ANA, display_name }));
      expect([err.status, err.code]).toEqual([400, "INVALID_COMMAND"]);
    }
    expect(personName(admin, ANA)).toBe("Ana Cruz");
  });

  test("an unchanged name writes no entry changes", async () => {
    const admin = fixture();
    const res = await send(admin, ORGANIZER, { person_id: ANA, display_name: "Ana Cruz" });
    expect(res.result).toMatchObject({ renamed_participants: [], skipped_participants: [] });
  });

  test("umpires, non-members and court stations can't rename players", async () => {
    const admin = fixture();
    for (const actor of [UMPIRE, STRANGER, STATION]) {
      const err = await fail(send(admin, actor, { person_id: ANA, display_name: "Hacked" }));
      expect(err.status).toBe(403);
    }
    expect(personName(admin, ANA)).toBe("Ana Cruz");
    expect(entryName(admin, "e-pair")).toBe("Ana Cruz / Ben Lim");
  });
});
