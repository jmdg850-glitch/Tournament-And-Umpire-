import { describe, expect, it, test } from "vitest";
import { applyLoadOutcome, stateFromCache } from "./lastKnownGood.js";
import {
  OFFLINE_IDENTITY_MAX_AGE_MS,
  classifyRefreshError,
  forgetVerified,
  probeIdentity,
  readLastVerified,
  readStoredIdentity,
  sessionGate,
  startIdentity,
  rememberVerified,
  resolveIdentity,
} from "./offlineIdentity.js";

const KEY = "sb-test-auth-token";
const UID = "11111111-1111-4111-8111-111111111111";
const NOW = 1_800_000_000_000;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

function storedSession(overrides = {}) {
  return JSON.stringify({
    access_token: "expired-access",
    refresh_token: "refresh-1",
    expires_at: Math.floor(NOW / 1000) - 3600,
    user: { id: UID, email: "op@example.com" },
    ...overrides,
  });
}

function retryable() {
  const err = new Error("Failed to fetch");
  err.name = "AuthRetryableFetchError";
  err.status = 0;
  return err;
}

function refused() {
  const err = new Error("Invalid Refresh Token");
  err.name = "AuthApiError";
  err.status = 400;
  return err;
}

function fakeSupabase({ refresh }) {
  return { auth: { storageKey: KEY, refreshSession: refresh } };
}

describe("readStoredIdentity", () => {
  it("returns only who the stored session belongs to — never a token", () => {
    const storage = memoryStorage({ [KEY]: storedSession() });
    const id = readStoredIdentity(KEY, storage);
    expect(id).toEqual({ userId: UID, email: "op@example.com" });
    expect(JSON.stringify(id)).not.toMatch(/refresh-1|expired-access/);
  });

  it("treats missing, corrupt, user-less or refresh-token-less storage as no identity", () => {
    expect(readStoredIdentity(KEY, memoryStorage())).toBeNull();
    expect(readStoredIdentity(KEY, memoryStorage({ [KEY]: "{not json" }))).toBeNull();
    expect(readStoredIdentity(KEY, memoryStorage({ [KEY]: storedSession({ user: null }) }))).toBeNull();
    expect(readStoredIdentity(KEY, memoryStorage({ [KEY]: storedSession({ refresh_token: "" }) }))).toBeNull();
    expect(readStoredIdentity(null, memoryStorage({ [KEY]: storedSession() }))).toBeNull();
  });
});

describe("classifyRefreshError", () => {
  it("separates unreachable-server from a server refusal", () => {
    expect(classifyRefreshError(retryable())).toBe("network");
    expect(classifyRefreshError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyRefreshError(Object.assign(new Error("bad gateway"), { status: 502 }))).toBe("network");
    expect(classifyRefreshError(refused())).toBe("auth");
    expect(classifyRefreshError(Object.assign(new Error("x"), { name: "AuthSessionMissingError", status: 400 }))).toBe("missing");
    expect(classifyRefreshError(null)).toBeNull();
  });
});

describe("resolveIdentity", () => {
  const stored = { userId: UID, email: "op@example.com" };

  it("a real session is always 'verified'", () => {
    const r = resolveIdentity({ session: { access_token: "t", user: { id: UID, email: "e" } }, now: NOW });
    expect(r).toEqual({ mode: "verified", userId: UID, email: "e" });
  });

  it("stored session + unreachable server + verified within 7 days → offline-unverified", () => {
    const r = resolveIdentity({ stored, lastVerifiedAt: NOW - 2 * 86400000, refreshErrorKind: "network", now: NOW });
    expect(r).toEqual({ mode: "offline-unverified", userId: UID, email: "op@example.com" });
  });

  it("a server REFUSAL (revoked/expired refresh token) is never offline mode", () => {
    expect(resolveIdentity({ stored, lastVerifiedAt: NOW, refreshErrorKind: "auth", now: NOW }).mode).toBe("signed-out");
    expect(resolveIdentity({ stored, lastVerifiedAt: NOW, refreshErrorKind: "missing", now: NOW }).mode).toBe("signed-out");
  });

  it("no stored session (explicit sign-out) → signed-out", () => {
    expect(resolveIdentity({ stored: null, lastVerifiedAt: NOW, refreshErrorKind: "network", now: NOW }).mode).toBe("signed-out");
  });

  it("never verified on this device, or older than the limit → signed-out", () => {
    expect(resolveIdentity({ stored, lastVerifiedAt: null, refreshErrorKind: "network", now: NOW }).mode).toBe("signed-out");
    expect(resolveIdentity({ stored, lastVerifiedAt: NOW - OFFLINE_IDENTITY_MAX_AGE_MS - 1, refreshErrorKind: "network", now: NOW }).mode).toBe("signed-out");
    expect(resolveIdentity({ stored, lastVerifiedAt: NOW - OFFLINE_IDENTITY_MAX_AGE_MS, refreshErrorKind: "network", now: NOW }).mode).toBe("offline-unverified");
  });

  it("a clock rolled back before the last verification → signed-out", () => {
    expect(resolveIdentity({ stored, lastVerifiedAt: NOW + 60 * 60 * 1000, refreshErrorKind: "network", now: NOW }).mode).toBe("signed-out");
  });
});

describe("verified timestamp", () => {
  it("is per user and can be forgotten", () => {
    const storage = memoryStorage();
    rememberVerified(UID, NOW, storage);
    expect(readLastVerified(UID, storage)).toBe(NOW);
    expect(readLastVerified("someone-else", storage)).toBeNull();
    forgetVerified(UID, storage);
    expect(readLastVerified(UID, storage)).toBeNull();
  });
});

describe("sessionGate (never let an anonymous/RLS-empty answer replace saved data)", () => {
  const withSession = (session) => ({ auth: { getSession: async () => ({ data: { session } }) } });

  test("a real session lets the load run", async () => {
    expect(await sessionGate(withSession({ access_token: "t", user: { id: UID } }))).toBeNull();
  });

  test("no session (expired + refresh failed, offline identity, signed out) → a failure that KEEPS saved rows", async () => {
    for (const client of [withSession(null), withSession(undefined), { auth: { getSession: async () => { throw new TypeError("Failed to fetch"); } } }]) {
      const gate = await sessionGate(client);
      expect(gate).toMatchObject({ ok: false, kind: "network" });
      const saved = stateFromCache({ rows: [{ id: "m1" }], savedAt: 5 });
      const next = applyLoadOutcome(saved, gate);
      expect(next.rows).toEqual([{ id: "m1" }]); // not replaced by an anonymous empty answer
    }
  });
});

describe("startIdentity (offline cold start must not sit on a splash screen)", () => {
  // A manual timer + a getSession we resolve by hand = a deterministic "auth
  // server not answering" (supabase-js retries the refresh for ~25 s offline).
  function harness({ refresh }) {
    let fire = null;
    let resolveGetSession;
    const supabase = {
      auth: {
        storageKey: KEY,
        getSession: () => new Promise((r) => { resolveGetSession = r; }),
        refreshSession: refresh,
      },
    };
    const reports = [];
    return {
      supabase,
      reports,
      opts: { setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => { fire = null; }, now: () => NOW },
      fireGrace: () => fire?.(),
      answer: async (session) => { await new Promise((r) => setTimeout(r, 0)); resolveGetSession({ data: { session } }); },
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("auth server not answering: the saved offline identity is available after the grace period, then confirmed when it fails", async () => {
    const storage = memoryStorage({ [KEY]: storedSession() });
    rememberVerified(UID, NOW - 3600_000, storage);
    const h = harness({ refresh: async () => ({ data: { session: null }, error: retryable() }) });
    startIdentity(h.supabase, (s) => h.reports.push(s), { ...h.opts, storage });
    h.fireGrace();
    expect(h.reports).toEqual([{ session: null, offlineIdentity: expect.objectContaining({ mode: "offline-unverified", userId: UID }), settled: false }]);
    await h.answer(null);
    await flush(); await flush();
    expect(h.reports.at(-1)).toMatchObject({ session: null, offlineIdentity: { mode: "offline-unverified", userId: UID }, settled: true });
  });

  test("the server later REFUSES the sign-in: the final report is signed out (sign-in screen)", async () => {
    const storage = memoryStorage({ [KEY]: storedSession() });
    rememberVerified(UID, NOW, storage);
    const h = harness({ refresh: async () => ({ data: { session: null }, error: refused() }) });
    startIdentity(h.supabase, (s) => h.reports.push(s), { ...h.opts, storage });
    h.fireGrace();
    await h.answer(null);
    await flush(); await flush();
    expect(h.reports.at(-1)).toEqual({ session: null, offlineIdentity: null, settled: true });
  });

  test("a quick real session: no provisional offline report at all", async () => {
    const storage = memoryStorage({ [KEY]: storedSession() });
    rememberVerified(UID, NOW, storage);
    const h = harness({ refresh: async () => ({ data: { session: null }, error: null }) });
    const session = { access_token: "fresh", user: { id: UID } };
    startIdentity(h.supabase, (s) => h.reports.push(s), { ...h.opts, storage });
    await h.answer(session);
    await flush();
    h.fireGrace(); // the grace timer was cleared, so this does nothing
    expect(h.reports).toEqual([{ session, offlineIdentity: null, settled: true }]);
  });

  test("never verified on this device: no early access while waiting", async () => {
    const storage = memoryStorage({ [KEY]: storedSession() });
    const h = harness({ refresh: async () => ({ data: { session: null }, error: retryable() }) });
    startIdentity(h.supabase, (s) => h.reports.push(s), { ...h.opts, storage });
    h.fireGrace();
    expect(h.reports).toEqual([]);
    await h.answer(null);
    await flush(); await flush();
    expect(h.reports).toEqual([{ session: null, offlineIdentity: null, settled: true }]);
  });

  test("stop() prevents any further reports", async () => {
    const storage = memoryStorage({ [KEY]: storedSession() });
    rememberVerified(UID, NOW, storage);
    const h = harness({ refresh: async () => ({ data: { session: null }, error: retryable() }) });
    const stop = startIdentity(h.supabase, (s) => h.reports.push(s), { ...h.opts, storage });
    stop();
    h.fireGrace();
    await h.answer(null);
    await flush(); await flush();
    expect(h.reports).toEqual([]);
  });
});

describe("probeIdentity", () => {
  it("offline cold start with an expired stored session → offline-unverified, and no session/token is returned", async () => {
    const storage = memoryStorage({ [KEY]: storedSession() });
    rememberVerified(UID, NOW - 3600_000, storage);
    const supabase = fakeSupabase({ refresh: async () => ({ data: { session: null }, error: retryable() }) });
    const r = await probeIdentity(supabase, { storage, now: () => NOW });
    expect(r.mode).toBe("offline-unverified");
    expect(r.userId).toBe(UID);
    expect(r.session).toBeNull();
  });

  it("refresh succeeds → verified with the real session", async () => {
    const storage = memoryStorage({ [KEY]: storedSession() });
    const session = { access_token: "fresh", user: { id: UID, email: "op@example.com" } };
    const supabase = fakeSupabase({ refresh: async () => ({ data: { session }, error: null }) });
    const r = await probeIdentity(supabase, { storage, now: () => NOW });
    expect(r.mode).toBe("verified");
    expect(r.session).toBe(session);
  });

  it("refresh refused by the server → signed-out even if verified recently", async () => {
    const storage = memoryStorage({ [KEY]: storedSession() });
    rememberVerified(UID, NOW, storage);
    const supabase = fakeSupabase({ refresh: async () => ({ data: { session: null }, error: refused() }) });
    expect((await probeIdentity(supabase, { storage, now: () => NOW })).mode).toBe("signed-out");
  });

  it("nothing stored → signed-out without calling the server", async () => {
    let called = false;
    const supabase = fakeSupabase({ refresh: async () => { called = true; return { data: {}, error: null }; } });
    const r = await probeIdentity(supabase, { storage: memoryStorage(), now: () => NOW });
    expect(r.mode).toBe("signed-out");
    expect(called).toBe(false);
  });

  it("a thrown network error is treated as unreachable", async () => {
    const storage = memoryStorage({ [KEY]: storedSession() });
    rememberVerified(UID, NOW, storage);
    const supabase = fakeSupabase({ refresh: async () => { throw new TypeError("Failed to fetch"); } });
    expect((await probeIdentity(supabase, { storage, now: () => NOW })).mode).toBe("offline-unverified");
  });
});
