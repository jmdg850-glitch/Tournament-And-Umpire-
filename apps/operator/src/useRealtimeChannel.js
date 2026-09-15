import { useEffect, useRef } from "react";
import { createCatchupBuffer } from "@tournament/engine";

export function useRealtimeChannel({ supabase, name, specs, enabled = true, onPayload, onSubscribed }) {
  const onPayloadRef = useRef(onPayload);
  const onSubscribedRef = useRef(onSubscribed);
  const specsRef = useRef(specs);
  onPayloadRef.current = onPayload;
  onSubscribedRef.current = onSubscribed;
  specsRef.current = specs;

  useEffect(() => {
    if (!enabled || !supabase || !name) return undefined;
    const buf = createCatchupBuffer();
    const apply = (payload) => onPayloadRef.current?.(payload);
    const wrapped = buf.wrap(apply);
    let channel = supabase.channel(name);
    for (const spec of specsRef.current || []) {
      channel = channel.on("postgres_changes", spec, wrapped);
    }
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        Promise.resolve(onSubscribedRef.current?.())
          .catch(() => {})
          .finally(() => buf.markReady(apply));
      }
    });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, name, enabled]);
}

export async function openLiveMatchWindow(tournamentId, matchId) {
  if (window.tournamentDesktop?.openLiveWindow) {
    return window.tournamentDesktop.openLiveWindow({ tournamentId, matchId });
  }
  const url = `${window.location.pathname}${window.location.search}#/live/${tournamentId}/${matchId}`;
  window.open(url, `tournament-live-${matchId}`, "noopener,noreferrer,width=920,height=640");
  return { ok: true, browser: true };
}

// Same established pattern as openLiveMatchWindow above: Electron gets its own
// managed BrowserWindow (see electron/main.cjs's createBracketWindow, which
// focuses/reuses one already open for this tournament instead of duplicating
// it); the plain-browser fallback uses a stable, tournament-scoped window
// *name* so the browser itself reuses/focuses the same tab/window rather than
// opening a second one for the same tournament's bracket.
export async function openBracketWindow(tournamentId) {
  if (!tournamentId) return { ok: false, error: "No tournament selected" };
  if (window.tournamentDesktop?.openBracketWindow) {
    return window.tournamentDesktop.openBracketWindow({ tournamentId });
  }
  const url = `${window.location.pathname}${window.location.search}#/bracket/${tournamentId}`;
  window.open(url, `tournament-bracket-${tournamentId}`, "noopener,noreferrer,width=1280,height=840");
  return { ok: true, browser: true };
}

// Division-scoped display window — the window *name*/key is per-division (not
// per-tournament), so Division A's window and Division B's window are always
// two independently addressable windows: opening Division B's display never
// reuses or repoints Division A's already-open one (see electron/main.cjs's
// createMatchWindow, keyed the same way).
export async function openMatchDisplayWindow(tournamentId, divisionId) {
  if (!tournamentId || !divisionId) return { ok: false, error: "No division selected" };
  if (window.tournamentDesktop?.openMatchWindow) {
    return window.tournamentDesktop.openMatchWindow({ tournamentId, divisionId });
  }
  const url = `${window.location.pathname}${window.location.search}#/matches-display/${tournamentId}/${divisionId}`;
  window.open(url, `tournament-matches-${divisionId}`, "noopener,noreferrer,width=1000,height=760");
  return { ok: true, browser: true };
}
