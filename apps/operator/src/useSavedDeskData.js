import { useCallback, useEffect, useRef, useState } from "react";
import { sessionGate } from "@tournament/client";
import { loadDeskData } from "./lib.js";
import { INITIAL_LOAD_INFO as INITIAL_INFO, LOAD_FAILURE_STATUS as FAILURE_STATUS, deskOutcome, mergeServerMatches } from "./offlineData.js";

// Read-only display windows (Bracket, Match display): loadDeskData with this
// computer's saved copy of the tournament as a fallback. They only READ the
// saved copy — the main window is the only writer.
//
// `session` is the window's account; `session.offline` marks the offline
// identity (sign-in not verified), in which no server query is made at all
// (it would run as an anonymous visitor and "succeed" with nothing).
export function useSavedDeskData({ supabase, session, repository, tournamentId }) {
  const verified = Boolean(session) && !session.offline;
  const [data, setData] = useState(null);
  const [info, setInfo] = useState(INITIAL_INFO);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    repository?.loadDesk(tournamentId).then((snap) => {
      if (cancelled || !snap) return;
      setData((prev) => prev ?? snap.data);
      setInfo((prev) => (prev.source === "server" ? prev : { ...prev, source: "cache", lastUpdatedAt: snap.savedAt }));
    });
    return () => { cancelled = true; };
  }, [repository, tournamentId]);

  // Overlapping loads (mount, realtime subscribe, focus): only the latest applies.
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    if (!verified) {
      setInfo((prev) => ({ ...prev, status: "offline" }));
      return null;
    }
    // An expired session makes supabase-js query anonymously (RLS → empty).
    if (await sessionGate(supabase)) {
      setInfo((prev) => ({ ...prev, status: "offline" }));
      return null;
    }
    const outcome = deskOutcome(await loadDeskData(supabase, tournamentId));
    if (seq !== loadSeqRef.current) return null;
    if (!outcome.ok) {
      setInfo((prev) => ({ ...prev, status: FAILURE_STATUS[outcome.kind] || "error", error: outcome.message }));
      if (outcome.kind !== "network" && outcome.kind !== "server") setError(outcome.message);
      return null;
    }
    setError("");
    setData((prev) => (prev?.tournament?.id === outcome.rows?.tournament?.id
      ? { ...outcome.rows, matches: mergeServerMatches(prev.matches, outcome.rows.matches) }
      : outcome.rows));
    setInfo({ status: "online", source: "server", lastUpdatedAt: outcome.at, error: "" });
    return outcome.rows;
  }, [supabase, tournamentId, verified]);

  // Realtime's "subscribed" callback also loads; this first load is what makes
  // an offline window settle (saved copy or a clear message) instead of
  // waiting on a subscription that can't happen.
  useEffect(() => { load(); }, [load]);

  return {
    data,
    setData,
    error,
    load,
    verified,
    identityMode: verified ? "verified" : "offline-unverified",
    bannerLoad: { rows: data, ...info },
    settled: info.status !== "loading" || data !== null,
  };
}
