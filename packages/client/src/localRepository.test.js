import { describe, expect, it } from "vitest";
import { createMemoryStore, enqueueCommand } from "./offlineQueue.js";
import { createTournamentRepository, sanitizeDeskData, snapshotKey } from "./localRepository.js";
import { applyLoadOutcome, deriveConnectionState, stateFromCache } from "./lastKnownGood.js";

const OWNER = "user:u1";

function deskData(overrides = {}) {
  return {
    tournament: { id: "t1", name: "Spring Open" },
    divisions: [{ id: "d1", config: { winTo: 11 } }],
    matches: [{ id: "m1", status: "in_progress", score_state: { lastSeq: 4 } }],
    courtDevices: [{ id: "cd1", court_id: "c1", tournament_id: "t1", status: "active", device_label: "Court 1", refresh_token_hash: "SECRET-HASH", last_seen_at: null }],
    ...overrides,
  };
}

describe("sanitizeDeskData", () => {
  it("drops court_devices.refresh_token_hash (and anything not on the allow-list) before saving", () => {
    const clean = sanitizeDeskData(deskData());
    expect(clean.courtDevices[0]).toEqual({ id: "cd1", court_id: "c1", tournament_id: "t1", status: "active", device_label: "Court 1", last_seen_at: null });
    expect(JSON.stringify(clean)).not.toContain("SECRET-HASH");
    expect(clean.matches).toEqual(deskData().matches);
  });
});

describe("createTournamentRepository", () => {
  it("saves and restores a tournament package across a 'restart' (new repository over the same store)", async () => {
    const store = createMemoryStore();
    await createTournamentRepository({ store, owner: OWNER }).saveDesk("t1", deskData(), 1000);
    const after = createTournamentRepository({ store, owner: OWNER });
    const snap = await after.loadDesk("t1");
    expect(snap.savedAt).toBe(1000);
    expect(snap.data.tournament.name).toBe("Spring Open");
    expect(JSON.stringify(snap)).not.toContain("SECRET-HASH");
  });

  it("never shows one account's saved package to another account", async () => {
    const store = createMemoryStore();
    await createTournamentRepository({ store, owner: OWNER }).saveDesk("t1", deskData(), 1000);
    const other = createTournamentRepository({ store, owner: "user:u2" });
    expect(await other.loadDesk("t1")).toBeNull();
    expect(await other.listOfflineReady()).toEqual([]);
  });

  it("a slow, older load can't overwrite a newer saved package", async () => {
    const store = createMemoryStore();
    const repo = createTournamentRepository({ store, owner: OWNER });
    await repo.saveDesk("t1", deskData({ matches: [{ id: "m1", score_state: { lastSeq: 9 } }] }), 2000);
    await repo.saveDesk("t1", deskData({ matches: [{ id: "m1", score_state: { lastSeq: 4 } }] }), 1500);
    expect((await repo.loadDesk("t1")).data.matches[0].score_state.lastSeq).toBe(9);
  });

  it("lists offline-ready tournaments newest first, and forget removes one", async () => {
    const store = createMemoryStore();
    const repo = createTournamentRepository({ store, owner: OWNER });
    await repo.saveDesk("t1", deskData(), 1000);
    await repo.saveDesk("t2", deskData({ tournament: { id: "t2", name: "Fall Cup" } }), 3000);
    await repo.saveDashboard({ rows: [{ id: "t1" }], meta: { live: 1 } }, 500);
    expect(await repo.listOfflineReady()).toEqual([
      { tournamentId: "t2", name: "Fall Cup", savedAt: 3000 },
      { tournamentId: "t1", name: "Spring Open", savedAt: 1000 },
    ]);
    await repo.forget("t2");
    expect((await repo.listOfflineReady()).map((x) => x.tournamentId)).toEqual(["t1"]);
  });

  it("round-trips the dashboard package", async () => {
    const store = createMemoryStore();
    const repo = createTournamentRepository({ store, owner: OWNER });
    await repo.saveDashboard({ rows: [{ id: "t1" }], meta: { live: 2 } }, 700);
    const snap = await repo.loadDashboard();
    expect(snap.data).toEqual({ rows: [{ id: "t1" }], meta: { live: 2 } });
    expect(snap.key).toBe(snapshotKey(OWNER, "dashboard"));
  });

  it("is inert (no throw) with no owner, no store, or a failing store", async () => {
    const none = createTournamentRepository({ store: null, owner: OWNER });
    expect(await none.saveDesk("t1", deskData())).toBe(false);
    expect(await none.loadDesk("t1")).toBeNull();
    const broken = {
      putSnapshot: async () => { throw new Error("quota"); },
      getSnapshot: async () => { throw new Error("corrupt"); },
      listSnapshots: async () => { throw new Error("corrupt"); },
      deleteSnapshot: async () => { throw new Error("corrupt"); },
    };
    const repo = createTournamentRepository({ store: broken, owner: OWNER });
    expect(await repo.saveDesk("t1", deskData())).toBe(false);
    expect(await repo.loadDesk("t1")).toBeNull();
    expect(await repo.listOfflineReady()).toEqual([]);
    expect(createTournamentRepository({ store: createMemoryStore(), owner: null }).usable).toBe(false);
  });

  it("snapshots live beside — and never disturb — the durable command outbox", async () => {
    const store = createMemoryStore();
    await enqueueCommand(store, { command_id: "c1", type: "score_event", payload: { match_id: "m1", seq: 1 }, owner: OWNER });
    await createTournamentRepository({ store, owner: OWNER }).saveDesk("t1", deskData(), 1000);
    expect((await store.list()).map((e) => e.command_id)).toEqual(["c1"]);
  });
});

describe("deriveConnectionState", () => {
  it("a network failure after a cached start keeps data and says 'offline — saved data', never 'Failed to fetch'", () => {
    const cached = stateFromCache({ rows: [{ id: "t1" }], savedAt: 1234 });
    const next = applyLoadOutcome(cached, { ok: false, kind: "network", message: "TypeError: Failed to fetch" });
    const s = deriveConnectionState({ load: next });
    expect(s.kind).toBe("offline-cached");
    expect(s.savedAt).toBe(1234);
    expect(s.label).not.toMatch(/Failed to fetch/);
  });

  it("offline with nothing saved says how to make it available offline", () => {
    const next = applyLoadOutcome(undefined, { ok: false, kind: "network", message: "TypeError: Failed to fetch" });
    const s = deriveConnectionState({ load: next });
    expect(s.kind).toBe("offline-empty");
    expect(s.label).toMatch(/while online/);
  });

  it("an empty SERVER answer is 'online', distinguishable from a network failure", () => {
    const next = applyLoadOutcome(undefined, { ok: true, rows: [], at: 5 });
    expect(deriveConnectionState({ load: next }).kind).toBe("online");
  });

  it("offline-unverified identity overrides everything", () => {
    const next = applyLoadOutcome(undefined, { ok: true, rows: [{ id: 1 }], at: 5 });
    expect(deriveConnectionState({ load: next, identityMode: "offline-unverified" }).kind).toBe("offline-unverified");
  });

  it("auth / forbidden / server are not 'offline'", () => {
    const base = stateFromCache({ rows: [], savedAt: 1 });
    expect(deriveConnectionState({ load: applyLoadOutcome(base, { ok: false, kind: "auth" }) }).kind).toBe("auth");
    expect(deriveConnectionState({ load: applyLoadOutcome(base, { ok: false, kind: "forbidden" }) }).kind).toBe("forbidden");
    expect(deriveConnectionState({ load: applyLoadOutcome(base, { ok: false, kind: "server" }) }).kind).toBe("server");
  });
});
