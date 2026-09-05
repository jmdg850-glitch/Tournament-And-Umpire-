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
