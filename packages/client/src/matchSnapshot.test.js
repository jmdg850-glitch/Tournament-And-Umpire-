import { describe, it, expect, beforeEach, vi } from "vitest";
import { readMatchSnapshot, writeMatchSnapshot, clearMatchSnapshot } from "./matchSnapshot.js";

function fakeLocalStorage() {
  const rows = new Map();
  return {
    getItem: (k) => (rows.has(k) ? rows.get(k) : null),
    setItem: (k, v) => rows.set(k, v),
    removeItem: (k) => rows.delete(k),
  };
}

describe("matchSnapshot", () => {
  beforeEach(() => {
    globalThis.localStorage = fakeLocalStorage();
  });

  it("returns null when nothing has been saved yet", () => {
    expect(readMatchSnapshot()).toBeNull();
  });

  it("round-trips a written snapshot", () => {
    const match = { id: "m1", status: "in_progress", score_state: { lastSeq: 3, scoreA: 9, scoreB: 4 } };
    writeMatchSnapshot("m1", match, 3);
    const read = readMatchSnapshot();
    expect(read.matchId).toBe("m1");
    expect(read.match).toEqual(match);
    expect(read.seq).toBe(3);
    expect(typeof read.savedAt).toBe("number");
  });

  it("overwrites the single slot on a second write (last write wins)", () => {
    writeMatchSnapshot("m1", { id: "m1" }, 1);
    writeMatchSnapshot("m2", { id: "m2" }, 5);
    const read = readMatchSnapshot();
    expect(read.matchId).toBe("m2");
    expect(read.seq).toBe(5);
  });

  it("clearMatchSnapshot removes the stored value", () => {
    writeMatchSnapshot("m1", { id: "m1" }, 1);
    clearMatchSnapshot();
    expect(readMatchSnapshot()).toBeNull();
  });

  it("readMatchSnapshot returns null instead of throwing on corrupt JSON", () => {
    globalThis.localStorage.setItem("tournament.umpire.matchSnapshot", "{not json");
    expect(readMatchSnapshot()).toBeNull();
  });

  it("readMatchSnapshot returns null instead of throwing when storage access itself throws (private browsing, etc.)", () => {
    globalThis.localStorage = {
      getItem: () => { throw new Error("SecurityError"); },
    };
    expect(readMatchSnapshot()).toBeNull();
  });

  it("writeMatchSnapshot swallows a storage write failure (quota exceeded) instead of throwing", () => {
    globalThis.localStorage = {
      setItem: () => { throw new Error("QuotaExceededError"); },
    };
    expect(() => writeMatchSnapshot("m1", { id: "m1" }, 1)).not.toThrow();
  });

  it("clearMatchSnapshot swallows a storage failure instead of throwing", () => {
    globalThis.localStorage = {
      removeItem: () => { throw new Error("SecurityError"); },
    };
    expect(() => clearMatchSnapshot()).not.toThrow();
  });
});
