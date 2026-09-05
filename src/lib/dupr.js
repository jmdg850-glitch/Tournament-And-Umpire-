// DUPR PARTNER API — client-side surface. Mirrors cloud.js's conventions
// (never throws, {ok,...} return shapes, Log-wrapped). Writes to DUPR always
// go through the submit-match / link-dupr-account Edge Functions (the only
// place the DUPR clientSecret lives); reads go straight through Postgres
// like the rest of the app, since dupr_match_submissions is a plain
// RLS-gated SELECT.
import { Log } from "./log.js";
import { Cloud } from "./cloud.js";

export const Dupr = {
  // Current caller's own DUPR link status (duprId/duprStatus/duprFullName).
  async myStatus(){
    const acc = await Cloud.myAccount();
    if(acc===undefined) return undefined; // network/RPC failure, not "unlinked"
    if(!acc) return null;
    return { duprId:acc.duprId, duprStatus:acc.duprStatus, duprFullName:acc.duprFullName, duprLinkedAt:acc.duprLinkedAt,
      duprSinglesRating:acc.duprSinglesRating, duprDoublesRating:acc.duprDoublesRating };
  },

  // Public-by-design config for the login iframe (base64 client key + which
  // DUPR host to embed) — never includes the client secret.
  async getSsoConfig(){
    const sb = await Cloud.getSupabaseClient();
    if(!sb) return { ok:false, error:"Cloud not available" };
    try{
      const { data, error } = await sb.functions.invoke("link-dupr-account", { body:{ mode:"sso-config" } });
      if(error) throw error;
      return data;
    }catch(e){ Log.error("system","Dupr getSsoConfig failed",{message:e?.message}); return { ok:false, error:e?.message||"Request failed" }; }
  },

  // Link the caller's own account via the real DUPR "Login with DUPR" iframe
  // flow (see DuprPanel.jsx) — {userToken, refreshToken, duprId, expiresAt?}
  // are exactly what the iframe's postMessage handshake hands back. There is
  // no email-lookup endpoint in the real DUPR API (confirmed against the live
  // spec), so this is the only real way to link an account of one's own.
  async linkSelfSso({userToken, refreshToken, duprId, expiresAt}){
    const sb = await Cloud.getSupabaseClient();
    if(!sb) return { ok:false, error:"Cloud not available" };
    try{
      const { data, error } = await sb.functions.invoke("link-dupr-account", { body:{ mode:"sso", userToken, refreshToken, duprId, expiresAt } });
      if(error) throw error;
      return data;
    }catch(e){ Log.error("system","Dupr linkSelfSso failed",{message:e?.message}); return { ok:false, error:e?.message||"Request failed" }; }
  },

  async disconnectSelf(){
    const sb = await Cloud.getSupabaseClient();
    if(!sb) return { ok:false, error:"Cloud not available" };
    try{
      const { data, error } = await sb.functions.invoke("link-dupr-account", { body:{ mode:"self", disconnect:true } });
      if(error) throw error;
      return data;
    }catch(e){ Log.error("system","Dupr disconnectSelf failed",{message:e?.message}); return { ok:false, error:e?.message||"Request failed" }; }
  },

  // Full-text DUPR name search — the real API has no email lookup, so
  // organizer-assisted guest linking searches by name and lets the organizer
  // pick the correct match from results (see PlayerEditPanel.jsx).
  async searchPlayers(query){
    const sb = await Cloud.getSupabaseClient();
    if(!sb) return { ok:false, error:"Cloud not available" };
    try{
      const { data, error } = await sb.functions.invoke("link-dupr-account", { body:{ mode:"search", query } });
      if(error) throw error;
      return data;
    }catch(e){ Log.error("system","Dupr searchPlayers failed",{message:e?.message}); return { ok:false, error:e?.message||"Request failed" }; }
  },

  // Organizer links a guest/manual roster row (no PickleLive account) to a
  // DUPR id already picked from searchPlayers' results.
  async linkGuest(mixmatchPlayerId, duprId){
    const sb = await Cloud.getSupabaseClient();
    if(!sb) return { ok:false, error:"Cloud not available" };
    try{
      const { data, error } = await sb.functions.invoke("link-dupr-account", { body:{ mode:"guest", mixmatchPlayerId, duprId } });
      if(error) throw error;
      return data;
    }catch(e){ Log.error("system","Dupr linkGuest failed",{message:e?.message}); return { ok:false, error:e?.message||"Request failed" }; }
  },

  // Submit one completed match to DUPR. Returns {ok, retryable, status?, matchCode?, error?, reason?, missing?}.
  async submitMatch(matchId){
    const sb = await Cloud.getSupabaseClient();
    if(!sb) return { ok:false, retryable:true, error:"Cloud not available" };
    try{
      const { data, error } = await sb.functions.invoke("submit-match", { body:{ matchId } });
      if(error) throw error;
      return data;
    }catch(e){ Log.error("system","Dupr submitMatch failed",{message:e?.message}); return { ok:false, retryable:true, error:e?.message||"Request failed" }; }
  },

  // Manual, on-demand rating-impact sync for an already-submitted match — reads
  // DUPR's own record (delta/teamRating/preMatchRatingAndImpact) and stores it
  // alongside the existing submission row. No polling loop; only ever runs when
  // called (Sync Center's "Sync Rating" button).
  async syncRating(matchId){
    const sb = await Cloud.getSupabaseClient();
    if(!sb) return { ok:false, error:"Cloud not available" };
    try{
      const { data, error } = await sb.functions.invoke("submit-match", { body:{ mode:"sync-rating", matchId } });
      if(error) throw error;
      return data;
    }catch(e){ Log.error("system","Dupr syncRating failed",{message:e?.message}); return { ok:false, error:e?.message||"Request failed" }; }
  },

  // Read-only: current submission status for a set of match ids (for badges on History/Scoring).
  async fetchSubmissionStatuses(matchIds){
    const sb = await Cloud.getSupabaseClient();
    if(!sb || !matchIds?.length) return {};
    try{
      const { data, error } = await sb.from("dupr_match_submissions")
        .select("match_id, status, dupr_match_code, last_error, next_retry_at")
        .in("match_id", matchIds);
      if(error) throw error;
      const byId = {};
      (data||[]).forEach(r=>{ byId[r.match_id] = { status:r.status, matchCode:r.dupr_match_code, lastError:r.last_error, nextRetryAt:r.next_retry_at }; });
      return byId;
    }catch(e){ Log.error("system","Dupr fetchSubmissionStatuses failed",{message:e?.message}); return {}; }
  },
};
