import { describe, it, expect, vi } from "vitest";
import { isNetworkError, createMemoryStore, sendCommandDurable, drainQueue, queueSize } from "./offlineQueue.js";

function networkError() {
  const err = new Error("fetch failed");
  return err;
}

function serverError(status, code) {
  const err = new Error("rejected");
  err.status = status;
  err.code = code;
  return err;
}

describe("isNetworkError", () => {
  it("is true for an error with no HTTP status (fetch itself never reached the server)", () => {
    expect(isNetworkError(networkError())).toBe(true);
  });

  it("is false for an error the server actually responded with (has a status)", () => {
    expect(isNetworkError(serverError(409, "ILLEGAL_TRANSITION"))).toBe(false);
  });

  it("is false for a null/undefined error", () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});

describe("sendCommandDurable", () => {
  it("returns the server result directly when the send succeeds — unchanged behavior", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, result: { match: { id: "m1" } } });
    const store = createMemoryStore();
    const result = await sendCommandDurable({ store, send, type: "start_match", payload: { match_id: "m1" } });
    expect(result).toEqual({ ok: true, result: { match: { id: "m1" } } });
    expect(await queueSize(store)).toBe(0);
  });

  it("queues the command and returns a queued sentinel on a network failure", async () => {
    const send = vi.fn().mockRejectedValue(networkError());
    const store = createMemoryStore();
    const result = await sendCommandDurable({ store, send, type: "score_event", payload: { match_id: "m1", type: "point" }, commandId: "cmd-1" });
    expect(result).toEqual({ ok: true, queued: true, command_id: "cmd-1" });
    expect(await queueSize(store)).toBe(1);
  });

  it("rethrows a real server rejection unchanged and does NOT queue it", async () => {
    const send = vi.fn().mockRejectedValue(serverError(403, "FORBIDDEN"));
    const store = createMemoryStore();
    await expect(sendCommandDurable({ store, send, type: "start_match", payload: {} })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await queueSize(store)).toBe(0);
  });

  it("generates its own command_id when none is provided, and that id is what gets queued", async () => {
    const send = vi.fn().mockRejectedValue(networkError());
    const store = createMemoryStore();
    const result = await sendCommandDurable({ store, send, type: "score_event", payload: {} });
    const queued = await store.list();
    expect(queued).toHaveLength(1);
    expect(queued[0].command_id).toBe(result.command_id);
  });
});

describe("drainQueue", () => {
  it("replays queued commands in FIFO order using each command's original command_id (idempotency key)", async () => {
    const store = createMemoryStore();
    await store.put({ command_id: "a", type: "score_event", payload: { n: 1 }, queuedAt: 1 });
    await store.put({ command_id: "b", type: "score_event", payload: { n: 2 }, queuedAt: 2 });
    const sentIds = [];
    const send = vi.fn().mockImplementation(({ commandId }) => {
      sentIds.push(commandId);
      return Promise.resolve({ ok: true, result: {} });
    });
    const result = await drainQueue({ store, send, getAccessToken: async () => "tok", publishableKey: "pk" });
    expect(sentIds).toEqual(["a", "b"]);
    expect(result).toEqual({ drained: 2, remaining: 0, stoppedOn: null });
    expect(await queueSize(store)).toBe(0);
  });

  it("stops draining (without dropping anything) when still offline, leaving the rest queued in order", async () => {
    const store = createMemoryStore();
    await store.put({ command_id: "a", type: "score_event", payload: {}, queuedAt: 1 });
    await store.put({ command_id: "b", type: "score_event", payload: {}, queuedAt: 2 });
    const send = vi.fn().mockRejectedValue(networkError());
    const result = await drainQueue({ store, send, getAccessToken: async () => "tok", publishableKey: "pk" });
    expect(result).toEqual({ drained: 0, remaining: 2, stoppedOn: "offline" });
    expect(await queueSize(store)).toBe(2);
  });

  it("stops draining and preserves order when the server actively rejects a queued command (a real conflict), instead of skipping ahead", async () => {
    const store = createMemoryStore();
    await store.put({ command_id: "a", type: "score_event", payload: {}, queuedAt: 1 });
    await store.put({ command_id: "b", type: "score_event", payload: {}, queuedAt: 2 });
    const send = vi.fn().mockRejectedValue(serverError(409, "ILLEGAL_TRANSITION"));
    const onEach = vi.fn();
    const result = await drainQueue({ store, send, getAccessToken: async () => "tok", publishableKey: "pk", onEach });
    expect(result).toEqual({ drained: 0, remaining: 2, stoppedOn: "rejected" });
    expect(await queueSize(store)).toBe(2);
    expect(onEach).toHaveBeenCalledWith(expect.objectContaining({ command_id: "a" }), null, expect.objectContaining({ status: 409 }));
  });

  it("removes a command from the queue only after it is confirmed sent", async () => {
    const store = createMemoryStore();
    await store.put({ command_id: "a", type: "score_event", payload: {}, queuedAt: 1 });
    const send = vi.fn().mockResolvedValueOnce({ ok: true, result: {} });
    await drainQueue({ store, send, getAccessToken: async () => "tok", publishableKey: "pk" });
    expect(await queueSize(store)).toBe(0);
  });

  it("does not attempt to send when no access token is available (expired auth, not yet refreshed) — leaves the queue untouched", async () => {
    const store = createMemoryStore();
    await store.put({ command_id: "a", type: "score_event", payload: {}, queuedAt: 1 });
    const send = vi.fn();
    const result = await drainQueue({ store, send, getAccessToken: async () => null, publishableKey: "pk" });
    expect(send).not.toHaveBeenCalled();
    expect(result.stoppedOn).toBe("no_token");
    expect(await queueSize(store)).toBe(1);
  });

  it("replays each command with its original type and payload, unchanged", async () => {
    const store = createMemoryStore();
    await store.put({ command_id: "a", type: "transition_match", payload: { match_id: "m1", status: "postponed", reason: "court injury" }, queuedAt: 1 });
    const send = vi.fn().mockResolvedValue({ ok: true, result: {} });
    await drainQueue({ store, send, getAccessToken: async () => "tok", publishableKey: "pk" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "transition_match",
      payload: { match_id: "m1", status: "postponed", reason: "court injury" },
      commandId: "a",
    }));
  });
});

describe("drainQueue concurrency", () => {
  it("never sends the same queued command twice when drainQueue is called again before the first call finishes — the exact bug a live browser test caught (two overlapping drains from an 'online' event and the fallback interval created two courts from one queued create_court)", async () => {
    const store = createMemoryStore();
    await store.put({ command_id: "a", type: "create_court", payload: {}, queuedAt: 1 });
    let resolveSend;
    const send = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
    const first = drainQueue({ store, send, getAccessToken: async () => "tok", publishableKey: "pk" });
    // Let `first` run up to (and including) its call to `send`, so it is
    // genuinely in flight — mirroring the live-browser race where a second
    // trigger (the fallback interval) fired while the first replay's fetch
    // to the server was still pending.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const second = await drainQueue({ store, send, getAccessToken: async () => "tok", publishableKey: "pk" });
    expect(second).toEqual({ drained: 0, remaining: 0, stoppedOn: "already_draining" });
    expect(send).toHaveBeenCalledTimes(1);
    resolveSend({ ok: true, result: {} });
    await first;
    expect(await queueSize(store)).toBe(0);
  });

  it("allows a fresh drain after a previous one has fully finished", async () => {
    const store = createMemoryStore();
    await store.put({ command_id: "a", type: "create_court", payload: {}, queuedAt: 1 });
    const send = vi.fn().mockResolvedValue({ ok: true, result: {} });
    await drainQueue({ store, send, getAccessToken: async () => "tok", publishableKey: "pk" });
    await store.put({ command_id: "b", type: "create_court", payload: {}, queuedAt: 2 });
    const result = await drainQueue({ store, send, getAccessToken: async () => "tok", publishableKey: "pk" });
    expect(result.drained).toBe(1);
  });
});

describe("createMemoryStore", () => {
  it("lists entries ordered by queuedAt regardless of insertion order", async () => {
    const store = createMemoryStore();
    await store.put({ command_id: "later", queuedAt: 20 });
    await store.put({ command_id: "earlier", queuedAt: 10 });
    const rows = await store.list();
    expect(rows.map((r) => r.command_id)).toEqual(["earlier", "later"]);
  });
});
