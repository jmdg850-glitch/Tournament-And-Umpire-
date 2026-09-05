// One Supabase Realtime channel per call, scoped to a single court — the right shape for a
// scoreboard window (exactly one consumer per renderer process), unlike useLiveBoard()'s
// ref-counted multi-subscriber store (right for the main app window's many consumers, wrong
// here). Returns the live/paused match on that court, or null if none.
import { useState, useEffect } from "react";
import { Cloud } from "./cloud.js";

const RECONNECT_MIN_MS=1000, RECONNECT_MAX_MS=10000;

export function useLiveMatchForCourt(courtId){
  const [match,setMatch]=useState(null);

  useEffect(()=>{
    if(!courtId || !Cloud.enabled) return;
    let cancelled=false, channel=null, pollTimer=null, reconnectTimer=null, backoff=RECONNECT_MIN_MS;

    const refetch=async()=>{
      const m=await Cloud.fetchLiveMatchForCourt(courtId);
      if(!cancelled && m!==null) setMatch(m);
    };

    const connect=async()=>{
      channel=await Cloud.subscribeLiveMatchForCourt(courtId,
        (row,evt)=>{ if(!cancelled) setMatch(evt==="DELETE"?null:row); },
        (status)=>{
          if(cancelled) return;
          if(status==="SUBSCRIBED"){ backoff=RECONNECT_MIN_MS; return; }
          // TIMED_OUT / CLOSED / CHANNEL_ERROR — tear down and reconnect with backoff so a
          // dropped Realtime connection recovers on its own instead of leaving the scoreboard
          // silently stale (the 15s poll below is a second line of defense either way).
          if(status==="TIMED_OUT" || status==="CLOSED" || status==="CHANNEL_ERROR"){
            if(channel){ Cloud.unsubscribeLiveBoard(channel); channel=null; }
            clearTimeout(reconnectTimer);
            reconnectTimer=setTimeout(()=>{
              if(cancelled) return;
              backoff=Math.min(backoff*2,RECONNECT_MAX_MS);
              refetch().finally(connect);
            },backoff);
          }
        });
    };

    (async()=>{
      await refetch();
      await connect();
      pollTimer=setInterval(refetch,15000); // fallback poll if Realtime is off, matches LiveBoard's convention
    })();

    return ()=>{
      cancelled=true;
      if(channel) Cloud.unsubscribeLiveBoard(channel);
      if(pollTimer) clearInterval(pollTimer);
      clearTimeout(reconnectTimer);
    };
  },[courtId]);

  return match;
}
