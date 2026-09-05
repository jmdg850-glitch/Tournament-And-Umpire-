// CLOUD SYNC (Supabase) — the entire data layer. All methods are safe no-ops
// when cloud isn't configured/available, and never throw.
//
// INVARIANT (do not "fix"): fetchLiveMatches/fetchLiveSessions return null on
// failure and [] only for a CONFIRMED empty result. "Couldn't check" must never
// read as "nothing is live", or prune/reconcile logic cancels genuinely
// in-progress matches.
import { Log } from "./log.js";
import { Outbox } from "./outbox.js";
import { Dupr } from "./dupr.js";
import { uid, today, PASSWORD_HINT } from "./utils.js";
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, RESET_REDIRECT, CONFIRM_REDIRECT,
  cloudEnabled,
} from "./config.js";

// Lazily load the Supabase client the first time it's actually needed. Prefers the BUNDLED
// @supabase/supabase-js npm package (always available offline-from-CDN, shipped in dist by
// Vite), falling back to the esm.sh CDN only for bundler-less preview sandboxes where the bare
// import can't resolve. A failed attempt no longer poisons the cache: _sbPromise is reset so
// the next Cloud call retries, instead of one transient network blip at boot permanently
// downgrading the whole session to local-only (which then read as "nothing is live" everywhere).
let _sb = null, _sbPromise = null;
function getSupabase(){
  if(!cloudEnabled) return Promise.resolve(null);
  if(_sb) return Promise.resolve(_sb);
  if(_sbPromise) return _sbPromise;
  _sbPromise = (async()=>{
    let mod = null;
    try{ mod = await import("@supabase/supabase-js"); }
    catch{
      try{ mod = await import(/* @vite-ignore */ /* webpackIgnore: true */ "https://esm.sh/@supabase/supabase-js@2"); }
      catch(e){ try{ Log.error("system","Supabase failed to load (will retry)",{message:e?.message}); }catch{ /* best-effort, safe to ignore */ } }
    }
    try{
      const createClient = mod && (mod.createClient || (mod.default && mod.default.createClient));
      if(!createClient){ _sbPromise=null; return null; }
      _sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      try{ Log.info("system","Cloud connected"); }catch{ /* best-effort, safe to ignore */ }
      return _sb;
    }catch(e){
      try{ Log.error("system","Supabase failed to init (will retry)",{message:e?.message}); }catch{ /* best-effort, safe to ignore */ }
      _sbPromise = null;
      return null;
    }
  })();
  return _sbPromise;
}

// Extract a clean, human-readable message from any thrown value / API error.
// Guards against empty objects (supabase-js sometimes sets message to "{}").
export function readErr(e, fallback){
  try{
    if(e==null) return fallback;
    if(typeof e==="string"){ const s=e.trim(); return (s&&s!=="{}"&&s!=="[object Object]")?s:fallback; }
    const cand=[e.message,e.error_description,e.msg,e.hint,typeof e.error==="string"?e.error:null];
    for(const c of cand){ const s=(typeof c==="string"?c:"").trim(); if(s&&s!=="{}"&&s!=="[object Object]") return s; }
    return fallback;
  }catch{ return fallback; }
}

// All methods are safe no-ops when cloud isn't configured/available, and never throw.
export const Cloud = {
  enabled: cloudEnabled,

  // Exposes the same lazily-loaded client other modules (e.g. dupr.js) need
  // for calls Cloud itself doesn't wrap (supabase.functions.invoke, etc.),
  // without duplicating the CDN-fallback loader above.
  async getSupabaseClient() { return await getSupabase(); },

  // Publish (or refresh) my public profile into the shared directory.
  async upsertProfile(u) {
    if (!u || !u.id) return;
    // players.name is NOT NULL — never publish a blank/placeholder name over a real one.
    if (!u.name || !u.name.trim()) return;
    const sb = await getSupabase(); if (!sb) return;
    try {
      await sb.from("players").upsert({
        id: u.id, name: u.name.trim(), email: u.email || null, photo: u.photo || null,
        hand: u.hand || "Right",
        singles_rating: +u.singlesRating || 3, doubles_rating: +u.doublesRating || 3,
        wins: u.wins || 0, losses: u.losses || 0, updated_at: new Date().toISOString(),
      });
    } catch (e) { Log.error("system", "Cloud upsertProfile failed", { message: e?.message }); }
  },

  // Pull everyone in the shared directory (mapped back to the app's player shape).
  async fetchDirectory() {
    const sb = await getSupabase(); if (!sb) return [];
    try {
      const { data, error } = await sb.from("players").select("*").order("updated_at", { ascending: false }).limit(500);
      if (error) throw error;
      return (data || []).map(r => ({
        id: r.id, name: r.name || "Player", email: r.email || "", photo: r.photo || null,
        hand: r.hand || "Right",
        singlesRating: +r.singles_rating || 3, doublesRating: +r.doubles_rating || 3,
        wins: r.wins || 0, losses: r.losses || 0, joinDate: r.updated_at, remote: true,
      }));
    } catch (e) { Log.error("system", "Cloud fetchDirectory failed", { message: e?.message }); return []; }
  },

  // Friend requests are keyed by the same global ids used in the directory.
  async sendFriendRequest(req) {
    if (!req) return;
    const sb = await getSupabase(); if (!sb) return;
    try {
      await sb.from("friend_requests").insert({
        id: req.id, from_id: req.from, to_id: req.to, status: req.status || "pending",
        created_at: new Date().toISOString(),
      });
    } catch (e) { Log.error("system", "Cloud sendFriendRequest failed", { message: e?.message }); }
  },
  async fetchFriendRequests(myId) {
    if (!myId) return [];
    const sb = await getSupabase(); if (!sb) return [];
    try {
      const { data, error } = await sb.from("friend_requests").select("*")
        .or(`from_id.eq.${myId},to_id.eq.${myId}`);
      if (error) throw error;
      return (data || []).map(r => ({ id: r.id, from: r.from_id, to: r.to_id, status: r.status, date: r.created_at, remote: true }));
    } catch (e) { Log.error("system", "Cloud fetchFriendRequests failed", { message: e?.message }); return []; }
  },
  async updateFriendRequest(id, status) {
    if (!id) return;
    const sb = await getSupabase(); if (!sb) return;
    try { await sb.from("friend_requests").update({ status }).eq("id", id); }
    catch (e) { Log.error("system", "Cloud updateFriendRequest failed", { message: e?.message }); }
  },
  async removeFriendRequest(id) {
    if (!id) return;
    const sb = await getSupabase(); if (!sb) return;
    try { await sb.from("friend_requests").delete().eq("id", id); }
    catch (e) { Log.error("system", "Cloud removeFriendRequest failed", { message: e?.message }); }
  },

  // ---- Shared events (calendar) ----
  async createEvent(ev) {
    const sb = await getSupabase(); if (!sb) return false;
    try {
      // ignoreDuplicates (INSERT ... ON CONFLICT DO NOTHING) instead of a plain insert — this
      // handler is Outbox-retried, and a lost/ambiguous response to an insert that actually
      // succeeded server-side used to make every retry 409 forever (permanently stuck queue
      // item). A no-op on an existing id is success for a "create" handler; unlike a merge
      // upsert, it also can't clobber created_at with a later retry's timestamp.
      const { error } = await sb.from("events").upsert({
        id: ev.id, club_id: ev.clubId || null, club_name: ev.clubName || null,
        title: ev.title, location: ev.location || null, date: ev.date, time: ev.time || null,
        duration: ev.duration || null,
        capacity: (ev.capacity == null || ev.capacity === Infinity) ? null : ev.capacity,
        price: +ev.price || 0, description: ev.description || null,
        owner_id: ev.ownerId, owner_name: ev.ownerName || null,
        created_at: new Date().toISOString(),
      }, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      // Owner auto-attends as "going"
      await sb.from("event_attendees").upsert({
        id: ev.id + "_" + ev.ownerId, event_id: ev.id, user_id: ev.ownerId,
        user_name: ev.ownerName || null, status: "going", created_at: new Date().toISOString(),
      }, { onConflict: "event_id,user_id" });
      return true;
    } catch (e) { Log.error("club", "Cloud createEvent failed", { message: e?.message }); return false; }
  },
  // Shared row-mapper so the REST fetch and the realtime payload handler (see
  // subscribeEventsChanges below) always produce identically-shaped objects — same convention
  // as _mapLiveMatchRow/_mapNotificationRow/_mapAccount.
  _mapEventRow(r) {
    if (!r) return null;
    return {
      id: r.id, clubId: r.club_id, clubName: r.club_name, title: r.title,
      location: r.location || "", date: r.date, time: r.time || "", duration: r.duration || "",
      capacity: r.capacity == null ? Infinity : r.capacity, price: +r.price || 0,
      description: r.description || "", ownerId: r.owner_id, ownerName: r.owner_name || "",
      organizerIds: Array.isArray(r.organizer_ids) ? r.organizer_ids : [],
      organizerNames: r.organizer_names || {},
      createdAt: r.created_at, remote: true,
    };
  },
  async fetchEvents() {
    const sb = await getSupabase(); if (!sb) return [];
    try {
      const { data, error } = await sb.from("events").select("*").order("date", { ascending: true }).limit(500);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapEventRow(r));
    } catch (e) { Log.error("club", "Cloud fetchEvents failed", { message: e?.message }); return []; }
  },
  async deleteEvent(id) {
    const sb = await getSupabase(); if (!sb) return;
    try { await sb.from("events").delete().eq("id", id); await sb.from("event_attendees").delete().eq("event_id", id); }
    catch (e) { Log.error("club", "Cloud deleteEvent failed", { message: e?.message }); }
  },
  // Instant delivery of event changes (organizer_ids/organizer_names updates from an accepted
  // invite, or title/date/location edits) via Supabase Realtime, instead of waiting for the
  // existing 10s fetchEvents() poll — this is what lets a freshly-accepted co-organizer's
  // permissions (and any owner's event edits) reach every other device immediately. Best-effort,
  // matches subscribeMyOwnedMatchInvites' shape exactly; returns null if unavailable.
  async subscribeEventsChanges(onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("events_changes")
        .on("postgres_changes", { event: "*", schema: "public", table: "events" }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapEventRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("club", "Cloud subscribeEventsChanges failed", { message: e?.message }); return null; }
  },
  // Edits an existing event's own metadata (title/date/time/location/description). Owner-only
  // at the call site — mirrors updateEventOrganizers' "this method just persists what it's
  // given" shape. Syncs to everyone via the existing 10s fetchEvents() poll.
  async updateEvent(id, patch) {
    const sb = await getSupabase(); if (!sb || !id || !patch) return;
    try {
      const row = {};
      if ("title" in patch) row.title = patch.title;
      if ("date" in patch) row.date = patch.date;
      if ("time" in patch) row.time = patch.time;
      if ("location" in patch) row.location = patch.location;
      if ("description" in patch) row.description = patch.description;
      if (!Object.keys(row).length) return;
      await sb.from("events").update(row).eq("id", id);
    } catch (e) { Log.error("club", "Cloud updateEvent failed", { message: e?.message }); }
  },
  // Add/remove co-organizers on an event. Owner-only at the call site (see addEventOrganizer/
  // removeEventOrganizer below) — this method itself just persists whatever list it's given.
  async updateEventOrganizers(eventId, organizerIds, organizerNames) {
    const sb = await getSupabase(); if (!sb || !eventId) return;
    try {
      await sb.from("events").update({
        organizer_ids: organizerIds || [], organizer_names: organizerNames || {},
      }).eq("id", eventId);
    } catch (e) { Log.error("club", "Cloud updateEventOrganizers failed", { message: e?.message }); }
  },

  // ---- Notifications (persistent per-user inbox) ----
  async sendNotification(n) {
    if (!n || !n.userId) return;
    const sb = await getSupabase(); if (!sb) return;
    try {
      await sb.from("notifications").insert({
        id: n.id || ("notif_" + uid()), user_id: n.userId, type: n.type || "generic",
        title: n.title || "", body: n.body || null, event_id: n.eventId || null,
        invite_id: n.inviteId || null, match_id: n.matchId || null,
        actor_id: n.actorId || null, actor_name: n.actorName || null,
        read: false, created_at: new Date().toISOString(),
      });
    } catch (e) { Log.error("system", "Cloud sendNotification failed", { message: e?.message }); }
  },
  // Idempotent notification send for match-lifecycle events — claims (matchId, userId, type) in
  // match_notification_events first (migration 144); only actually sends the notification if
  // this call is the one that wins the claim. Prevents a schedule regeneration, realtime echo,
  // or repeated bracket-advancement pass from re-notifying the same player for the same match.
  // n.actorId must be the caller's own id (auth.uid()) — notifications_insert's RLS policy
  // requires coalesce(actor_id, auth.uid()) = auth.uid() unless the caller is an admin.
  async sendNotificationOnce(n) {
    if (!n || !n.userId || !n.matchId || !n.type) return false;
    const sb = await getSupabase(); if (!sb) return false;
    try {
      const { data, error } = await sb.from("match_notification_events")
        .upsert({ match_id: n.matchId, user_id: n.userId, type: n.type }, { onConflict: "match_id,user_id,type", ignoreDuplicates: true })
        .select();
      if (error) throw error;
      if (!data || !data.length) {
        Log.info("system", "[NOTIFICATION] Duplicate suppressed", { matchId: n.matchId, userId: n.userId, type: n.type });
        return false;
      }
      await Cloud.sendNotification(n);
      Log.info("system", "[NOTIFICATION] Notification inserted", { matchId: n.matchId, userId: n.userId, type: n.type });
      return true;
    } catch (e) { Log.error("system", "Cloud sendNotificationOnce failed", { message: e?.message }); return false; }
  },
  // Shared row-mapper so the REST fetch and the realtime insert handler (see
  // subscribeMyNotifications below) always produce identically-shaped objects.
  _mapNotificationRow(r) {
    if (!r) return null;
    return {
      id: r.id, userId: r.user_id, type: r.type, title: r.title, body: r.body || "",
      eventId: r.event_id || null, inviteId: r.invite_id || null, matchId: r.match_id || null,
      actorId: r.actor_id || null, actorName: r.actor_name || null,
      read: !!r.read, createdAt: r.created_at, remote: true,
    };
  },
  async fetchNotifications(userId) {
    if (!userId) return [];
    const sb = await getSupabase(); if (!sb) return [];
    try {
      const { data, error } = await sb.from("notifications").select("*").eq("user_id", userId)
        .order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapNotificationRow(r));
    } catch (e) { Log.error("system", "Cloud fetchNotifications failed", { message: e?.message }); return []; }
  },
  async markNotificationRead(id) {
    if (!id) return;
    const sb = await getSupabase(); if (!sb) return;
    try { await sb.from("notifications").update({ read: true }).eq("id", id); }
    catch (e) { Log.error("system", "Cloud markNotificationRead failed", { message: e?.message }); }
  },
  // Instant delivery of new notifications (not just organizer invites) via Supabase Realtime,
  // instead of waiting for the existing 10s poll. Best-effort — returns null if Realtime/Supabase
  // isn't available, matching subscribeLiveBoard's fallback-to-polling convention.
  async subscribeMyNotifications(userId, onInsert) {
    const sb = await getSupabase(); if (!sb || !userId) return null;
    try {
      const channel = sb.channel("notifications_" + userId)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: "user_id=eq." + userId }, (payload) => {
          try { const mapped = Cloud._mapNotificationRow(payload.new); if (mapped && onInsert) onInsert(mapped); } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeMyNotifications failed", { message: e?.message }); return null; }
  },
  // Generic Realtime channel teardown, shared by every subscribe*/unsubscribe* pair in this file.
  async removeChannel(channel) {
    if (!channel) return;
    try { const sb = await getSupabase(); if (sb) sb.removeChannel(channel); } catch{ /* best-effort, safe to ignore */ }
  },
  async joinEvent(a) {
    const sb = await getSupabase(); if (!sb || !a) return;
    try {
      await sb.from("event_attendees").upsert({
        id: a.id || (a.eventId + "_" + a.userId), event_id: a.eventId, user_id: a.userId,
        user_name: a.userName || null, status: a.status || "pending",
        is_guest: !!a.isGuest, guest_of: a.guestOf || null,
        roles: a.roles ? JSON.stringify(a.roles) : null,
        play_status: a.playStatus || null, team: a.team || null, court: a.court || null, payment: a.payment || null,
        created_at: new Date().toISOString(),
      }, { onConflict: "event_id,user_id" });
    } catch (e) { Log.error("club", "Cloud joinEvent failed", { message: e?.message }); }
  },
  async fetchAttendees() {
    const sb = await getSupabase(); if (!sb) return [];
    try {
      const { data, error } = await sb.from("event_attendees").select("*").limit(2000);
      if (error) throw error;
      return (data || []).map(r => ({ id: r.id, eventId: r.event_id, userId: r.user_id, userName: r.user_name || "", status: r.status, isGuest: !!r.is_guest, guestOf: r.guest_of || null,
        roles: (()=>{ try{ return r.roles?JSON.parse(r.roles):[]; }catch{ return []; } })(), playStatus: r.play_status || null, team: r.team || null, court: r.court || null, payment: r.payment || null,
        createdAt: r.created_at }));
    } catch (e) { Log.error("club", "Cloud fetchAttendees failed", { message: e?.message }); return []; }
  },
  async setAttendeeStatus(eventId, userId, status) {
    const sb = await getSupabase(); if (!sb) return;
    try { await sb.from("event_attendees").update({ status }).eq("event_id", eventId).eq("user_id", userId); }
    catch (e) { Log.error("club", "Cloud setAttendeeStatus failed", { message: e?.message }); }
  },
  // Update any attendee management fields (roles/team/court/payment/play status)
  async updateAttendee(eventId, userId, patch) {
    const sb = await getSupabase(); if (!sb || !patch) return;
    try {
      const row = {};
      if ("status" in patch) row.status = patch.status;
      if ("playStatus" in patch) row.play_status = patch.playStatus;
      if ("team" in patch) row.team = patch.team;
      if ("court" in patch) row.court = patch.court;
      if ("payment" in patch) row.payment = patch.payment;
      if ("roles" in patch) row.roles = patch.roles ? JSON.stringify(patch.roles) : null;
      if (!Object.keys(row).length) return;
      await sb.from("event_attendees").update(row).eq("event_id", eventId).eq("user_id", userId);
    } catch (e) { Log.error("club", "Cloud updateAttendee failed", { message: e?.message }); }
  },
  async removeAttendee(eventId, userId) {
    const sb = await getSupabase(); if (!sb) return;
    try { await sb.from("event_attendees").delete().eq("event_id", eventId).eq("user_id", userId); }
    catch (e) { Log.error("club", "Cloud removeAttendee failed", { message: e?.message }); }
  },
  // ---- Profiles (accounts table stores PROFILE ONLY; Supabase Auth owns credentials) ----
  _mapAccount(r){
    if(!r) return null;
    return {
      id: r.id, name: r.name, username: r.username || null, email: r.email,
      hand: r.hand || "Right", photo: r.photo || null, role: r.role || "player", banned: !!r.banned,
      singlesRating: +r.singles_rating || 3, doublesRating: +r.doubles_rating || 3,
      wins: r.wins || 0, losses: r.losses || 0, joinDate: r.join_date || null,
      age: r.age || null, sex: r.sex || null, address: r.address || null, country: r.country || null, phone: r.phone || null,
      duprId: r.dupr_id || null, duprFullName: r.dupr_full_name || null,
      duprStatus: r.dupr_status || "unlinked", duprLinkedAt: r.dupr_linked_at || null,
      duprSinglesRating: r.dupr_singles_rating!=null ? +r.dupr_singles_rating : null,
      duprDoublesRating: r.dupr_doubles_rating!=null ? +r.dupr_doubles_rating : null,
      remote: true,
    };
  },
  async findAccount(email) {
    const sb = await getSupabase(); if (!sb || !email) return null;
    try {
      const { data, error } = await sb.from("accounts").select("*").eq("email", String(email).trim().toLowerCase()).limit(1);
      if (error) throw error;
      return Cloud._mapAccount((data || [])[0]);
    } catch (e) { Log.error("auth", "Cloud findAccount failed", { message: e?.message }); return null; }
  },
  async findAccountById(id) {
    const sb = await getSupabase(); if (!sb || !id) return null;
    try {
      const { data, error } = await sb.from("accounts").select("*").eq("id", id).limit(1);
      if (error) throw error;
      return Cloud._mapAccount((data || [])[0]);
    } catch (e) { Log.error("auth", "Cloud findAccountById failed", { message: e?.message }); return null; }
  },
  async findAccountByUsername(username) {
    const sb = await getSupabase(); if (!sb || !username) return null;
    try {
      const { data, error } = await sb.from("accounts").select("*").ilike("username", String(username).trim()).limit(1);
      if (error) throw error;
      return Cloud._mapAccount((data || [])[0]);
    } catch (e) { Log.error("auth", "Cloud findAccountByUsername failed", { message: e?.message }); return null; }
  },
  // Username/email -> email resolution for the login/signup screens, via the resolve_login()
  // RPC (works pre-session, without a permissive SELECT policy on accounts). Falls back to the
  // old direct-select behavior if the RPC isn't available yet (e.g. pre-101 database), so this
  // build works unchanged against either migration state.
  async resolveLogin(identifier) {
    const sb = await getSupabase(); if (!sb || !identifier) return null;
    try {
      const { data, error } = await sb.rpc("resolve_login", { identifier: String(identifier).trim() });
      if (error) throw error;
      return data || null;
    } catch (e) {
      Log.error("auth", "Cloud resolveLogin RPC failed, falling back to direct lookup", { message: e?.message });
      const acc = await Cloud.findAccountByUsername(identifier);
      return acc?.email || null;
    }
  },
  // Caller's own full profile row, including PII columns (email/phone/address/age/sex) that a
  // direct accounts select can no longer return once the column-level grant is applied — see
  // my_account() in migrations-prepared/101_policies_identity.sql.
  // Returns: the account row if found, null if CONFIRMED no row exists yet, or undefined if
  // the check itself failed (network/RPC error) — same null-vs-undetermined convention as
  // fetchLiveMatches/fetchLiveSessions above. Callers must not treat undefined as "no profile"
  // or they'll recreate/overwrite a real row with placeholder data on a transient failure.
  async myAccount() {
    const sb = await getSupabase(); if (!sb) return undefined;
    try {
      const { data, error } = await sb.rpc("my_account");
      if (error) throw error;
      // my_account() is declared `returns public.accounts` (a single composite row, not
      // setof) — when no row matches, Postgres/PostgREST serializes that as an object with
      // every column null (via row_to_json(NULL::accounts)), NOT a JSON null. `data` is
      // therefore always a truthy object; check data.id specifically to tell "found" from
      // "confirmed no row yet".
      return (data && data.id) ? Cloud._mapAccount(data) : null;
    } catch (e) { Log.error("auth", "Cloud myAccount failed", { message: e?.message }); return undefined; }
  },
  // Resolve-or-create the caller's own profile row via the ensure_my_account() RPC (migration
  // 140_ensure_my_account_rpc.sql) — the server-authoritative replacement for the old
  // myAccount()+createAccount() dance, which never checked whether the insert actually
  // persisted (see App.jsx's ensureProfile()). Also safely re-keys a pre-existing row whose
  // email matches the caller's own verified session (e.g. a legacy pre-Auth-id row) instead of
  // failing on the accounts.email unique constraint. Returns the account row, or undefined if
  // the call itself failed (network/RPC error) — never fabricate a profile on that path.
  async ensureMyAccount() {
    const sb = await getSupabase(); if (!sb) return undefined;
    try {
      const { data, error } = await sb.rpc("ensure_my_account");
      if (error) throw error;
      return (data && data.id) ? Cloud._mapAccount(data) : undefined;
    } catch (e) { Log.error("auth", "Cloud ensureMyAccount failed", { message: e?.message }); return undefined; }
  },
  // Insert the profile row (id MUST be the Supabase Auth user id).
  async createAccount(acc) {
    const sb = await getSupabase(); if (!sb || !acc) return { ok: false, offline: true };
    const row = {
      id: acc.id, name: acc.name, username: acc.username || null, email: acc.email,
      hand: acc.hand || "Right", photo: acc.photo || null, role: acc.role || "player", banned: !!acc.banned,
      singles_rating: +acc.singlesRating || 3, doubles_rating: +acc.doublesRating || 3,
      wins: acc.wins || 0, losses: acc.losses || 0, join_date: acc.joinDate || null,
      age: acc.age || null, sex: acc.sex || null, address: acc.address || null, country: acc.country || null, phone: acc.phone || null,
      created_at: new Date().toISOString(),
    };
    try {
      const { error } = await sb.from("accounts").insert(row);
      if (error) {
        // If a row with this id already exists (retry after a partial signup), upsert instead of failing.
        if (/duplicate|already exists|conflict/i.test(error.message || "") && !/username/i.test(error.message || "")) {
          const up = await sb.from("accounts").upsert(row);
          if (up.error) throw up.error;
          return { ok: true };
        }
        throw error;
      }
      return { ok: true };
    } catch (e) { Log.error("auth", "Cloud createAccount failed", { message: e?.message }); return { ok: false, err: readErr(e, e?.message || "insert failed") }; }
  },
  // Persist an edit from the profile screens (name/photo/hand/phone/email) to the accounts row
  // that hydrate()/myAccount() read back on every fresh login — see accounts_update RLS policy
  // in 101_policies_identity.sql (id = auth.uid()::text), already in place for this.
  async updateAccount(id, patch) {
    const sb = await getSupabase(); if (!sb || !id || !patch) return { ok: false, offline: true };
    const row = {};
    if ("name" in patch) row.name = patch.name;
    if ("photo" in patch) row.photo = patch.photo;
    if ("hand" in patch) row.hand = patch.hand;
    if ("phone" in patch) row.phone = patch.phone;
    if ("email" in patch) row.email = patch.email;
    if (!Object.keys(row).length) return { ok: true };
    try {
      const { error } = await sb.from("accounts").update(row).eq("id", id);
      if (error) throw error;
      return { ok: true };
    } catch (e) { Log.error("auth", "Cloud updateAccount failed", { message: e?.message }); return { ok: false, err: readErr(e, e?.message || "update failed") }; }
  },
  async deleteAccountRow(id) {
    const sb = await getSupabase(); if (!sb || !id) return;
    try { await sb.from("accounts").delete().eq("id", id); }
    catch (e) { Log.error("auth", "Cloud deleteAccountRow failed", { message: e?.message }); }
  },

  // ---- Supabase Auth (the ONE source of truth for credentials) ----
  // Create the auth user first; the caller inserts the profile only if this succeeds.
  async authSignUp(email, password) {
    const sb = await getSupabase();
    if (!sb) return { ok:false, error:"Cloud isn't connected. Set up Supabase to create accounts." };
    try {
      const { data, error } = await sb.auth.signUp({
        email: String(email).trim().toLowerCase(), password,
        options: { emailRedirectTo: CONFIRM_REDIRECT },
      });
      if (error) throw error;
      const user = data && data.user;
      if (!user || !user.id) return { ok:false, error:"Sign up failed. Please try again." };
      return { ok:true, userId:user.id, session:data.session||null };
    } catch (e) {
      const raw = readErr(e,"Couldn't create the account. Please try again.");
      let msg = raw;
      if (/already registered|already been registered|user already exists|duplicate/i.test(raw)) msg = "An account with this email already exists.";
      else if (/password/i.test(raw) && /(least|weak|short|length)/i.test(raw)) msg = PASSWORD_HINT;
      else if (/network|fetch|failed to fetch/i.test(raw)) msg = "Network error. Check your connection and try again.";
      Log.error("auth","Cloud authSignUp failed",{message:e?.message});
      return { ok:false, error:msg, raw };
    }
  },
  async authSignIn(email, password) {
    const sb = await getSupabase();
    if (!sb) return { ok:false, error:"Cloud isn't connected." };
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email:String(email).trim().toLowerCase(), password });
      if (error) throw error;
      const user = data && data.user;
      if (!user || !user.id) return { ok:false, error:"Invalid username/email or password." };
      return { ok:true, userId:user.id, email:user.email };
    } catch (e) {
      const raw = readErr(e,"Invalid username/email or password.");
      let msg = "Invalid username/email or password.";
      if (/email not confirmed|not confirmed/i.test(raw)) msg = "Please confirm your email first — check your inbox for the confirmation link.";
      else if (/network|fetch|failed to fetch/i.test(raw)) msg = "Network error. Check your connection and try again.";
      Log.error("auth","Cloud authSignIn failed",{message:e?.message});
      return { ok:false, error:msg, raw };
    }
  },
  // Delete the just-created auth user if the profile insert fails (best-effort rollback).
  async authDeleteCurrent() {
    const sb = await getSupabase(); if (!sb) return;
    try {
      if (sb.auth.admin && sb.auth.admin.deleteUser) {
        const { data } = await sb.auth.getUser();
        if (data && data.user && data.user.id) await sb.auth.admin.deleteUser(data.user.id);
      }
    } catch{ /* best-effort, safe to ignore */ }
    try { await sb.auth.signOut(); } catch{ /* best-effort, safe to ignore */ }
  },
  async getAuthUser() {
    const sb = await getSupabase(); if (!sb) return null;
    try { const { data } = await sb.auth.getUser(); return data ? data.user : null; } catch { return null; }
  },
  // ---- Supabase built-in password recovery (reset link emailed to the user) ----
  async sendPasswordReset(email) {
    const sb = await getSupabase();
    if (!sb) return { sent:false, error:"Cloud isn't connected yet. Set up Supabase to enable password recovery." };
    try {
      const { error } = await sb.auth.resetPasswordForEmail(String(email).trim().toLowerCase(), { redirectTo: RESET_REDIRECT });
      if (error) throw error;
      Log.event("auth","Password reset email sent",{email:String(email).trim().toLowerCase()});
      return { sent:true };
    } catch (e) { Log.error("auth","Cloud sendPasswordReset failed",{message:e?.message}); return { sent:false, error:readErr(e,"Couldn't send the reset email. In Supabase → Authentication, make sure Email is enabled.") }; }
  },
  // Establish a session from whatever the recovery/confirmation link delivered:
  //   • PKCE flow  → ?code=... in the query  → exchangeCodeForSession
  //   • implicit   → #access_token&refresh_token in the hash → setSession
  // Safe to call on every load; returns {recovery:true} when it was a password-recovery link.
  // Pass `urlOverride` when the link was delivered outside window.location (e.g. a Capacitor
  // deep link on native Android, where the webview URL never becomes the emailed https:// link).
  async establishSessionFromUrl(urlOverride) {
    const sb = await getSupabase(); if (!sb) return { ok:false };
    let href, hash, search, pathname;
    if (urlOverride) {
      try {
        const u = new URL(urlOverride);
        href = u.href; hash = u.hash || ""; search = u.search || ""; pathname = u.pathname || "";
      } catch { return { ok:false }; }
    } else {
      if (typeof window === "undefined" || !window.location) return { ok:false };
      href = window.location.href || "";
      hash = window.location.hash || "";
      search = window.location.search || "";
      pathname = window.location.pathname || "";
    }
    const isRecovery = /type=recovery/.test(hash) || /type=recovery/.test(search) || /[?&]reset=1/.test(search) || /\/reset-password/.test(pathname);
    try {
      // PKCE: ?code=...
      const codeMatch = /[?&]code=([^&]+)/.exec(search);
      if (codeMatch && sb.auth.exchangeCodeForSession) {
        const { error } = await sb.auth.exchangeCodeForSession(href);
        if (error) throw error;
        return { ok:true, recovery:isRecovery };
      }
      // Implicit: #access_token=...&refresh_token=...
      if (/access_token=/.test(hash)) {
        const p = new URLSearchParams(hash.replace(/^#/, ""));
        const access_token = p.get("access_token");
        const refresh_token = p.get("refresh_token");
        const type = p.get("type");
        if (access_token && refresh_token) {
          const { error } = await sb.auth.setSession({ access_token, refresh_token });
          if (error) throw error;
          return { ok:true, recovery:isRecovery || type==="recovery" };
        }
      }
      return { ok:false, recovery:isRecovery };
    } catch (e) {
      Log.error("auth","establishSessionFromUrl failed",{message:e?.message});
      let msg = readErr(e,"This link is invalid or has expired. Request a new one.");
      if (/expired|invalid|used|not found/i.test(msg)) msg = "This reset link is invalid, already used, or expired. Request a new one.";
      return { ok:false, recovery:isRecovery, error:msg };
    }
  },
  // Complete a reset when the user opens the emailed link (session is set from the URL).
  async updatePasswordFromRecovery(newPassword) {
    const sb = await getSupabase();
    if (!sb) return { ok:false, error:"Cloud isn't connected." };
    try {
      const { data:{ session } } = await sb.auth.getSession();
      if (!session) return { ok:false, error:"Reset link is invalid or has expired. Request a new one." };
      const email = session.user && session.user.email;
      const { error } = await sb.auth.updateUser({ password:newPassword });
      if (error) throw error;
      return { ok:true, email };
    } catch (e) { Log.error("auth","Cloud updatePasswordFromRecovery failed",{message:e?.message}); return { ok:false, error:readErr(e,"Couldn't update the password. Request a new reset link.") }; }
  },
  // Change password while already logged in.
  async updatePassword(newPassword) {
    const sb = await getSupabase();
    if (!sb) return { ok:false, error:"Cloud isn't connected." };
    try {
      const { error } = await sb.auth.updateUser({ password:newPassword });
      if (error) throw error;
      return { ok:true };
    } catch (e) { Log.error("auth","Cloud updatePassword failed",{message:e?.message}); return { ok:false, error:readErr(e,"Couldn't update the password.") }; }
  },
  onAuth(cb) {
    let unsub = () => {};
    let cancelled = false;
    getSupabase().then(sb => {
      if (!sb || cancelled) return;
      try {
        const { data } = sb.auth.onAuthStateChange((event, session) => { try { cb(event, session); } catch{ /* best-effort, safe to ignore */ } });
        unsub = () => { try { data.subscription.unsubscribe(); } catch{ /* best-effort, safe to ignore */ } };
      } catch{ /* best-effort, safe to ignore */ }
    });
    return () => { cancelled = true; unsub(); };
  },
  async getSession() {
    const sb = await getSupabase(); if (!sb) return null;
    try { const { data } = await sb.auth.getSession(); return data ? data.session : null; } catch { return null; }
  },
  async signOutAuth() {
    const sb = await getSupabase(); if (!sb) return;
    try { await sb.auth.signOut(); } catch{ /* best-effort, safe to ignore */ }
  },

  // ---- Shared clubs (stored as a JSON document per club) ----
  async upsertClub(club) {
    const sb = await getSupabase(); if (!sb || !club || !club.id) return;
    try {
      await sb.from("clubs").upsert({
        id: club.id, owner_id: club.creatorId || null, name: club.clubName || "Club",
        data: club, updated_at: new Date().toISOString(),
      });
    } catch (e) { Log.error("club", "Cloud upsertClub failed", { message: e?.message }); }
  },
  async fetchClubs() {
    const sb = await getSupabase(); if (!sb) return [];
    try {
      const { data, error } = await sb.from("clubs").select("*").order("updated_at", { ascending: false }).limit(500);
      if (error) throw error;
      return (data || []).map(r => ({ ...(r.data || {}), id: r.id, remote: true }));
    } catch (e) { Log.error("club", "Cloud fetchClubs failed", { message: e?.message }); return []; }
  },
  async deleteClub(id) {
    const sb = await getSupabase(); if (!sb) return;
    try { await sb.from("clubs").delete().eq("id", id); }
    catch (e) { Log.error("club", "Cloud deleteClub failed", { message: e?.message }); }
  },

  // ---- Shared match history (one JSON document per completed match) ----
  async upsertMatch(m) {
    const sb = await getSupabase(); if (!sb || !m || !m.id) return false;
    try {
      // Was missing the {error} check entirely — an RLS rejection here (e.g. the umpire
      // completion-write-holes gap, see migration 130) came back as a normal resolved
      // promise, not a thrown exception, so this always returned true regardless of whether
      // the row was actually written. Outbox then treated it as delivered and dropped the
      // item — permanently losing the completed-match history row with no retry and no
      // visible error anywhere. Reproduced live: umpire-completed match never got a matches
      // row, which then made the tournament_matches completion PATCH fail its
      // completed_match_id foreign key too.
      const { error } = await sb.from("matches").upsert({
        id: m.id, participants: (m.participants || []).join(","), data: m,
        date: m.date || null, created_at: new Date().toISOString(),
      });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("match", "Cloud upsertMatch failed", { message: e?.message }); return false; }
  },
  // Read-only batch fetch for tournamentStatistics.js's duration stats — `data.createdAt`
  // (set once, when the live match started) and the row's own `created_at` (set once, by
  // upsertMatch above, at completion) are the only real start/completion timestamp pair
  // that exists anywhere for a match, tournament or casual.
  async fetchMatchesByIds(ids) {
    const sb = await getSupabase(); if (!sb || !ids?.length) return [];
    try {
      const { data, error } = await sb.from("matches").select("id,data,created_at").in("id", ids).limit(500);
      if (error) throw error;
      return (data || []).map(r => ({ id: r.id, data: r.data || {}, createdAt: r.created_at }));
    } catch (e) { Log.error("system", "Cloud fetchMatchesByIds failed", { message: e?.message }); return []; }
  },
  // Shared row-mapper so the REST fetch and the realtime payload handler (see
  // subscribeMatchesChanges below) always produce identically-shaped objects — same convention
  // as _mapEventRow/_mapLiveMatchRow/_mapNotificationRow.
  _mapMatchRow(r) {
    if (!r) return null;
    return { ...(r.data || {}), id: r.id, remote: true };
  },
  async fetchMatches() {
    const sb = await getSupabase(); if (!sb) return [];
    try {
      const { data, error } = await sb.from("matches").select("*").order("created_at", { ascending: false }).limit(500);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapMatchRow(r));
    } catch (e) { Log.error("match", "Cloud fetchMatches failed", { message: e?.message }); return []; }
  },
  // Instant delivery of newly-completed matches via Supabase Realtime, instead of waiting for the
  // existing 10s fetchMatches() poll — this is what makes a match finishing move to History
  // immediately for every connected viewer instead of appearing to linger/vanish-then-reappear.
  // INSERT-only: a completed match's history row is only ever written once (see endMatch's
  // Outbox.enqueue("upsertMatch",...)) — there is no update/delete flow for history rows in this
  // app, so nothing else needs to be subscribed to here.
  async subscribeMatchesChanges(onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("matches_changes")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "matches" }, (payload) => {
          try { const mapped = Cloud._mapMatchRow(payload.new); if (mapped && onChange) onChange(mapped); } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("match", "Cloud subscribeMatchesChanges failed", { message: e?.message }); return null; }
  },

  // ---- Shared chat (events + clubs). scope: 'event' | 'club' ----
  async sendMessage(msg) {
    const sb = await getSupabase(); if (!sb || !msg) return;
    try {
      await sb.from("messages").insert({
        id: msg.id, scope: msg.scope, scope_id: msg.scopeId,
        user_id: msg.userId, user_name: msg.userName || null, text: msg.text,
        created_at: new Date().toISOString(),
      });
    } catch (e) { Log.error("club", "Cloud sendMessage failed", { message: e?.message }); }
  },
  async fetchMessages() {
    const sb = await getSupabase(); if (!sb) return [];
    try {
      const { data, error } = await sb.from("messages").select("*").order("created_at", { ascending: true }).limit(1000);
      if (error) throw error;
      return (data || []).map(r => ({ id: r.id, scope: r.scope, scopeId: r.scope_id, userId: r.user_id, userName: r.user_name || "", text: r.text, ts: r.created_at }));
    } catch (e) { Log.error("club", "Cloud fetchMessages failed", { message: e?.message }); return []; }
  },

  // ---- Feed: news / announcements everyone can post & see ----
  async createPost(p) {
    const sb = await getSupabase(); if (!sb || !p) return;
    try {
      await sb.from("posts").insert({
        id: p.id, author_id: p.authorId, author_name: p.authorName || null, author_photo: p.authorPhoto || null,
        club_id: p.clubId || null, club_name: p.clubName || null, text: p.text || "", image: p.image || null,
        likes: JSON.stringify(p.likes || []), created_at: new Date().toISOString(),
      });
    } catch (e) { Log.error("system", "Cloud createPost failed", { message: e?.message }); }
  },
  async fetchPosts() {
    const sb = await getSupabase(); if (!sb) return [];
    try {
      const { data, error } = await sb.from("posts").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return (data || []).map(r => ({
        id: r.id, authorId: r.author_id, authorName: r.author_name || "Player", authorPhoto: r.author_photo || null,
        clubId: r.club_id || null, clubName: r.club_name || null, text: r.text || "", image: r.image || null,
        likes: (()=>{ try{ return r.likes?JSON.parse(r.likes):[]; }catch{ return []; } })(), ts: r.created_at, remote: true,
      }));
    } catch (e) { Log.error("system", "Cloud fetchPosts failed", { message: e?.message }); return []; }
  },
  // Toggling a like on someone else's post can't go through a plain row update (RLS only lets
  // the author touch other columns) — routed through the toggle_post_like() RPC instead, which
  // is scoped server-side to just the `likes` column. Returns the authoritative new likes array.
  async likePost(id) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const { data, error } = await sb.rpc("toggle_post_like", { post_id: id });
      if (error) throw error;
      try { return JSON.parse(data || "[]"); } catch { return []; }
    } catch (e) { Log.error("system", "Cloud likePost failed", { message: e?.message }); return null; }
  },
  async deletePost(id) {
    const sb = await getSupabase(); if (!sb) return;
    try { await sb.from("posts").delete().eq("id", id); }
    catch (e) { Log.error("system", "Cloud deletePost failed", { message: e?.message }); }
  },

  // ---- Live matches (active courts + live scores, for the Live Match view) ----
  // Written best-effort as the match starts / scores / finishes. Row is removed
  // when the match completes (its final result is persisted via upsertMatch).
  async upsertLiveMatch(payload) {
    const sb = await getSupabase(); if (!sb || !payload || !payload.id) return false;
    try {
      const { error } = await sb.from("live_matches").upsert({
        id: payload.id,
        court_id: payload.courtId || null,
        court_name: payload.courtName || null,
        status: payload.status || "in_progress",
        score_a: +payload.scoreA || 0,
        score_b: +payload.scoreB || 0,
        data: payload,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("match", "Cloud upsertLiveMatch failed", { message: e?.message }); return false; }
  },
  // Shared row-mapper so the REST fetch and the realtime payload handler (see
  // subscribeLiveBoard below) always produce identically-shaped objects — no duplicated,
  // driftable mapping logic between the two code paths.
  _mapLiveMatchRow(r) {
    if (!r) return null;
    return { ...(r.data || {}), id: r.id, courtId: r.court_id, courtName: r.court_name, status: r.status, scoreA: +r.score_a || 0, scoreB: +r.score_b || 0, updatedAt: r.updated_at, remote: true };
  },
  async fetchLiveMatches() {
    // null (not []) when the client is unavailable: "couldn't check" must never read as
    // "confirmed nothing is live" — reconcileOwnLiveMatches' prune would otherwise cancel
    // every genuinely in-progress local match the moment the cloud layer hiccups.
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const { data, error } = await sb.from("live_matches").select("*").order("updated_at", { ascending: false }).limit(200);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapLiveMatchRow(r));
    } catch (e) { Log.error("match", "Cloud fetchLiveMatches failed", { message: e?.message }); return null; }
  },
  async deleteLiveMatch(id) {
    const sb = await getSupabase(); if (!sb || !id) return false;
    try {
      // Supabase/Postgres does NOT error when RLS silently filters a DELETE down to zero
      // affected rows — .select("id") on the delete lets us tell "actually removed" apart
      // from "blocked" (e.g. a just-accepted co-organizer invite whose organizerIds hasn't
      // synced onto this row yet — see 102_policies_matches_live.sql's delete policy).
      // Trusting a bare {error:null} as success here is what leaves ghost live matches
      // behind: Outbox drops the retry the instant this returns true.
      const { data, error } = await sb.from("live_matches").delete().eq("id", id).select("id");
      if (error) throw error;
      if ((data || []).length > 0) return true;
      // Zero rows affected — confirm whether the row is actually gone (already deleted by
      // another path: success) or still present (RLS blocked this caller: report failure
      // so Outbox keeps retrying until organizerIds/permissions catch up).
      const { data: still, error: checkErr } = await sb.from("live_matches").select("id").eq("id", id).maybeSingle();
      if (checkErr) throw checkErr;
      return !still;
    }
    catch (e) { Log.error("match", "Cloud deleteLiveMatch failed", { message: e?.message }); return false; }
  },

  // ---- Live Match Board: organizer session metadata (event name/round/waiting queue/sitting
  // out players), one row per organizer, plus a Realtime channel so every logged-in user sees
  // live/waiting/court/queue changes pushed instantly instead of waiting for a poll. ----
  _mapLiveSessionRow(r) {
    if (!r) return null;
    return {
      organizerId: r.organizer_id, organizerName: r.organizer_name || "Organizer",
      eventName: r.event_name || ((r.organizer_name || "Organizer") + "'s Session"),
      eventId: r.event_id || null,
      round: r.round || 1,
      queue: Array.isArray(r.queue) ? r.queue : [],
      sittingOut: Array.isArray(r.sitting_out) ? r.sitting_out : [],
      playerNames: r.player_names || {},
      updatedAt: r.updated_at,
    };
  },
  async fetchLiveSessions() {
    // null on no-client, matching fetchLiveMatches — see the comment there.
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const { data, error } = await sb.from("live_sessions").select("*").limit(200);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapLiveSessionRow(r));
    } catch (e) { Log.error("match", "Cloud fetchLiveSessions failed", { message: e?.message }); return null; }
  },
  async upsertLiveSession(organizerId, session) {
    const sb = await getSupabase(); if (!sb || !organizerId || !session) return;
    try {
      await sb.from("live_sessions").upsert({
        organizer_id: organizerId, organizer_name: session.organizerName || null,
        event_name: session.eventName || null, event_id: session.eventId || null, round: +session.round || 1,
        queue: session.queue || [], sitting_out: session.sittingOut || [],
        player_names: session.playerNames || {}, updated_at: new Date().toISOString(),
      });
    } catch (e) { Log.error("match", "Cloud upsertLiveSession failed", { message: e?.message }); }
  },
  async deleteLiveSession(organizerId) {
    const sb = await getSupabase(); if (!sb || !organizerId) return;
    try { await sb.from("live_sessions").delete().eq("organizer_id", organizerId); }
    catch (e) { Log.error("match", "Cloud deleteLiveSession failed", { message: e?.message }); }
  },
  // Opens ONE Realtime channel covering both live_matches and live_sessions. Never throws —
  // returns null if Realtime/Supabase isn't available, so callers can fall back to polling.
  async subscribeLiveBoard({ onMatchChange, onSessionChange }) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("live_board")
        .on("postgres_changes", { event: "*", schema: "public", table: "live_matches" }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapLiveMatchRow(row);
            if (mapped && onMatchChange) onMatchChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "live_sessions" }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapLiveSessionRow(row);
            if (mapped && onSessionChange) onSessionChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeLiveBoard failed", { message: e?.message }); return null; }
  },
  async unsubscribeLiveBoard(channel) {
    return Cloud.removeChannel(channel);
  },
  // Court-scoped variants for the external scoreboard window — a scoreboard window watches
  // exactly one court, so it fetches/subscribes to just that row instead of the whole board
  // (useLiveBoard's shared, ref-counted store is the right shape for the main app window's many
  // consumers, but wasteful for a window with exactly one).
  async fetchLiveMatchForCourt(courtId) {
    const sb = await getSupabase(); if (!sb || !courtId) return null;
    try {
      const { data, error } = await sb.from("live_matches").select("*").eq("court_id", courtId).limit(1).maybeSingle();
      if (error) throw error;
      return data ? Cloud._mapLiveMatchRow(data) : null;
    } catch (e) { Log.error("match", "Cloud fetchLiveMatchForCourt failed", { message: e?.message }); return null; }
  },
  // onStatus (optional) receives supabase-js's own subscribe status
  // (SUBSCRIBED|TIMED_OUT|CLOSED|CHANNEL_ERROR, ...) so a caller can detect a dropped
  // connection and reconnect — see useLiveMatchForCourt's watchdog, the only consumer today.
  async subscribeLiveMatchForCourt(courtId, onChange, onStatus) {
    const sb = await getSupabase(); if (!sb || !courtId) return null;
    try {
      const channel = sb.channel("live_match_court_" + courtId)
        .on("postgres_changes", { event: "*", schema: "public", table: "live_matches", filter: "court_id=eq." + courtId }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapLiveMatchRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe((status, err) => { try { onStatus?.(status, err); } catch{ /* best-effort, safe to ignore */ } });
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeLiveMatchForCourt failed", { message: e?.message }); return null; }
  },

  // ---- Organizer Invites: pending → accepted/declined co-organizer invitations, EITHER for a
  // whole Event (event_id set — the primary path once a match belongs to an Event; acceptance
  // cascades organizer access to every match inside that Event, see
  // syncEventOrganizersFromInvites below) OR for a single standalone match (match_id set,
  // event_id null — the original, unchanged path, used only when a match has no Event, e.g. the
  // no-active-session "Manually Assign" shortcut). Distinct from events' own
  // organizer_ids/organizer_names columns being instant-add elsewhere (event creation still
  // writes those directly for the owner) — this table is what gates OTHER people getting added
  // to them. match.organizerIds/events.organizer_ids only ever hold ids that have reached
  // status='accepted' here. ----
  async createMatchOrganizerInvite(invite) {
    const sb = await getSupabase(); if (!sb || !invite || !invite.id) return false;
    try {
      // Was missing the {error} check entirely (see migration 130's postmortem on the same
      // anti-pattern in upsertMatch) — an RLS rejection or duplicate-key conflict here came back
      // as a normal resolved promise, not a thrown exception, so this always returned true
      // regardless of whether the row was actually written, and Outbox silently dropped the
      // retry. Also switched insert -> upsert/ignoreDuplicates since this handler is
      // Outbox-retried: a lost/ambiguous response to a successful insert would otherwise 409
      // forever on every retry.
      const { error } = await sb.from("match_organizer_invites").upsert({
        id: invite.id, match_id: invite.matchId || null, event_id: invite.eventId || null,
        owner_id: invite.ownerId, owner_name: invite.ownerName || null,
        invitee_id: invite.inviteeId, invitee_name: invite.inviteeName || null,
        court_name: invite.courtName || null, match_summary: invite.matchSummary || null,
        status: "pending", created_at: new Date().toISOString(),
      }, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("match", "Cloud createMatchOrganizerInvite failed", { message: e?.message }); return false; }
  },
  // Used for both accept ("accepted") and decline ("declined").
  async respondMatchOrganizerInvite(inviteId, status) {
    const sb = await getSupabase(); if (!sb || !inviteId) return { ok: false };
    try {
      const { data, error } = await sb.from("match_organizer_invites")
        .update({ status, responded_at: new Date().toISOString() }).eq("id", inviteId).select().limit(1);
      if (error) throw error;
      const r = (data || [])[0];
      return { ok: true, invite: r ? { id: r.id, matchId: r.match_id, eventId: r.event_id, ownerId: r.owner_id, ownerName: r.owner_name, inviteeId: r.invitee_id, inviteeName: r.invitee_name, courtName: r.court_name, status: r.status } : null };
    } catch (e) { Log.error("match", "Cloud respondMatchOrganizerInvite failed", { message: e?.message }); return { ok: false }; }
  },
  // The only place that ever recomputes a match's co-organizer roster: reads every ACCEPTED
  // invite for this match, then folds that set into the live_matches row's organizerIds/
  // organizerNames (the same fields canControlMatch/reconcileOwnLiveMatches already read — zero
  // changes needed anywhere else). Run by the match OWNER's device only (see
  // subscribeMyOwnedMatchInvites) — under this table's strict per-row RLS a co-organizer can't
  // see other co-organizers' accepted rows for the same match, but every row for a match shares
  // the same owner_id, so the owner can always see the complete picture. No-op/safe to re-run.
  async syncMatchOrganizersFromInvites(matchId) {
    const sb = await getSupabase(); if (!sb || !matchId) return false;
    try {
      const { data: invites, error: invErr } = await sb.from("match_organizer_invites")
        .select("invitee_id,invitee_name").eq("match_id", matchId).eq("status", "accepted");
      if (invErr) throw invErr;
      const { data: rows, error: rowErr } = await sb.from("live_matches").select("*").eq("id", matchId).limit(1);
      if (rowErr) throw rowErr;
      const row = (rows || [])[0]; if (!row) return false; // match no longer live — nothing to patch
      const organizerIds = (invites || []).map(i => i.invitee_id);
      const organizerNames = Object.fromEntries((invites || []).map(i => [i.invitee_id, i.invitee_name || "Organizer"]));
      const payload = { ...(row.data || {}), organizerIds, organizerNames };
      // A scoped UPDATE (not upsert) — if the match was deleted between the SELECT above
      // and this write (e.g. the owner ended/cancelled it right as an invite acceptance
      // triggered this sync), an UPDATE simply matches zero rows. An upsert would instead
      // INSERT a fresh row on that same conflict-free path, resurrecting a just-deleted
      // ghost match. Only data/updated_at actually change here — no need to rewrite the
      // other columns back with the same values this function just read from them.
      const { error: updErr } = await sb.from("live_matches")
        .update({ data: payload, updated_at: new Date().toISOString() })
        .eq("id", row.id);
      if (updErr) throw updErr;
      return true;
    } catch (e) { Log.error("match", "Cloud syncMatchOrganizersFromInvites failed", { message: e?.message }); return false; }
  },
  // The Event-level counterpart of syncMatchOrganizersFromInvites above, and the reason "manage
  // the complete Event" actually works without re-inviting per match: reads every ACCEPTED
  // invite for this event_id and writes that roster onto events.organizer_ids/organizer_names
  // (via the existing, unchanged updateEventOrganizers) — the single source of truth for who
  // controls this event. canControlMatch defers to the event's live organizerIds for any
  // event-linked match (see canControlMatch), so there's no per-match cache to keep patched
  // here anymore. Run by the event OWNER's device only — under this table's strict RLS only the
  // owner can see every invite row for their own event (an invitee only sees their own row).
  async syncEventOrganizersFromInvites(eventId) {
    const sb = await getSupabase(); if (!sb || !eventId) return false;
    try {
      const { data: invites, error: invErr } = await sb.from("match_organizer_invites")
        .select("invitee_id,invitee_name").eq("event_id", eventId).eq("status", "accepted");
      if (invErr) throw invErr;
      const organizerIds = (invites || []).map(i => i.invitee_id);
      const organizerNames = Object.fromEntries((invites || []).map(i => [i.invitee_id, i.invitee_name || "Organizer"]));
      await Cloud.updateEventOrganizers(eventId, organizerIds, organizerNames);
      return true;
    } catch (e) { Log.error("match", "Cloud syncEventOrganizersFromInvites failed", { message: e?.message }); return false; }
  },
  // Lets the match/event OWNER's device react the instant one of their sent invites is accepted
  // (or declined), instead of waiting for the poll fallback in the cloud-sync effect.
  async subscribeMyOwnedMatchInvites(ownerId, onChange) {
    const sb = await getSupabase(); if (!sb || !ownerId) return null;
    try {
      const channel = sb.channel("match_organizer_invites_owner_" + ownerId)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "match_organizer_invites", filter: "owner_id=eq." + ownerId }, (payload) => {
          try { if (payload.new && onChange) onChange(payload.new); } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("match", "Cloud subscribeMyOwnedMatchInvites failed", { message: e?.message }); return null; }
  },

  // ---- Mix & Match player roster (manual + imported + added-registered players) ----
  async fetchMixPlayers(organizerId) {
    const sb = await getSupabase(); if (!sb || !organizerId) return [];
    try {
      const { data, error } = await sb.from("mixmatch_players").select("*").eq("organizer_id", organizerId).limit(1000);
      if (error) throw error;
      return (data || []).map(r => ({
        id: r.id, name: r.name || "Player", gender: r.gender || "", phone: r.phone || "", email: r.email || "",
        hand: "Right", rating: +r.skill_level || 3, singlesRating: +r.skill_level || 3, doublesRating: +r.skill_level || 3,
        wins: 0, losses: 0, photo: null, joinDate: today(),
        source: r.source || "manual", linkedUserId: r.linked_user_id || null, banned: !!r.banned,
        categories: [], teamId: r.team_id || null, duprId: r.dupr_id || null,
      }));
    } catch (e) { Log.error("player", "Cloud fetchMixPlayers failed", { message: e?.message }); return []; }
  },
  async upsertMixPlayer(p, organizerId) {
    const sb = await getSupabase(); if (!sb || !p || !p.id || !organizerId) return false;
    try {
      // dupr_id is deliberately NOT included here — it's written only by the
      // link-dupr-account Edge Function (service role). Including a client-cached
      // duprId in this general-purpose upsert (fired on every rating/roster change)
      // risks clobbering a freshly-server-set value with a stale local copy.
      await sb.from("mixmatch_players").upsert({
        id: p.id, organizer_id: organizerId, name: p.name || "Player", gender: p.gender || null,
        skill_level: +p.singlesRating || 3, phone: p.phone || null, email: p.email || null,
        source: p.source || "manual", linked_user_id: p.linkedUserId || null, banned: !!p.banned,
        team_id: p.teamId || null,
        updated_at: new Date().toISOString(),
      });
      return true;
    } catch (e) { Log.error("player", "Cloud upsertMixPlayer failed", { message: e?.message }); return false; }
  },
  async deleteMixPlayer(id) {
    const sb = await getSupabase(); if (!sb || !id) return;
    try { await sb.from("mixmatch_players").delete().eq("id", id); }
    catch (e) { Log.error("player", "Cloud deleteMixPlayer failed", { message: e?.message }); }
  },
  // Automatic guest -> account merge: runs once at account creation/login. Finds every guest/
  // manual/imported roster row (across ALL organizers — rosters are organizer-scoped, so a
  // guest added by one organizer is otherwise invisible to another) whose email or phone
  // matches this account's, and links it the same way the manual linkPlayerToAccount flow does:
  // only linked_user_id/source change on the existing row (same id, same match/rating history),
  // so this can never create a duplicate match or stat. Best-effort, never blocks sign-up.
  async autoLinkGuestsByContact(accountId, { email, phone } = {}) {
    const sb = await getSupabase(); if (!sb || !accountId || (!email && !phone)) return;
    try {
      const clauses = [];
      if (email) clauses.push(`email.eq.${email}`);
      if (phone) clauses.push(`phone.eq.${phone}`);
      const { data, error } = await sb.from("mixmatch_players").select("id")
        .or(clauses.join(","))
        .is("linked_user_id", null)
        .neq("source", "registered")
        .neq("id", accountId);
      if (error) throw error;
      const rows = data || [];
      if (!rows.length) return;
      await sb.from("mixmatch_players")
        .update({ linked_user_id: accountId, source: "registered", updated_at: new Date().toISOString() })
        .in("id", rows.map(r => r.id));
      // Best-effort cleanup of any pre-existing duplicate row under the account's own id
      // (mixmatch_players.id is a global primary key, so at most one such row can exist).
      await sb.from("mixmatch_players").delete().eq("id", accountId);
    } catch (e) { Log.error("player", "Cloud autoLinkGuestsByContact failed", { message: e?.message }); }
  },

  // ---- Rating Engine v2: per-match rating history + organizer-configurable starting rating ----
  async recordRatingHistory(row) {
    const sb = await getSupabase(); if (!sb || !row || !row.playerId) return false;
    try {
      await sb.from("rating_history").insert({
        id: row.id || ("rh_" + uid()), player_id: row.playerId, organizer_id: row.organizerId || null,
        match_id: row.matchId || null, rating_type: row.ratingType || "singles",
        rating_before: row.ratingBefore, rating_after: row.ratingAfter, delta: row.delta,
        confidence_before: row.confidenceBefore, confidence_after: row.confidenceAfter,
        created_at: new Date().toISOString(),
      });
      return true;
    } catch (e) { Log.error("player", "Cloud recordRatingHistory failed", { message: e?.message }); return false; }
  },
  async fetchRatingHistory(playerId) {
    const sb = await getSupabase(); if (!sb || !playerId) return [];
    try {
      const { data, error } = await sb.from("rating_history").select("*").eq("player_id", playerId)
        .order("created_at", { ascending: true }).limit(200);
      if (error) throw error;
      return (data || []).map(r => ({
        id: r.id, playerId: r.player_id, matchId: r.match_id, ratingType: r.rating_type,
        ratingBefore: +r.rating_before || 0, ratingAfter: +r.rating_after || 0, delta: +r.delta || 0,
        confidenceBefore: r.confidence_before, confidenceAfter: r.confidence_after, createdAt: r.created_at,
      }));
    } catch (e) { Log.error("player", "Cloud fetchRatingHistory failed", { message: e?.message }); return []; }
  },
  async upsertRatingConfig(organizerId, cfg) {
    const sb = await getSupabase(); if (!sb || !organizerId || !cfg) return;
    try {
      await sb.from("rating_config").upsert({
        organizer_id: organizerId, base_rating: +cfg.baseRating || 3.000,
        dupr_auto_submit: !!cfg.duprAutoSubmit, updated_at: new Date().toISOString(),
      });
    } catch (e) { Log.error("admin", "Cloud upsertRatingConfig failed", { message: e?.message }); }
  },
  async fetchRatingConfig(organizerId) {
    const sb = await getSupabase(); if (!sb || !organizerId) return null;
    try {
      const { data, error } = await sb.from("rating_config").select("*").eq("organizer_id", organizerId).limit(1);
      if (error) throw error;
      const r = (data || [])[0];
      return r ? { baseRating: +r.base_rating || 3.000, duprAutoSubmit: !!r.dupr_auto_submit } : null;
    } catch (e) { Log.error("admin", "Cloud fetchRatingConfig failed", { message: e?.message }); return null; }
  },

  // ---- Player Categories (organizer-scoped, used to filter Mix & Match) ----
  async fetchMixCategories(organizerId) {
    const sb = await getSupabase(); if (!sb || !organizerId) return [];
    try {
      const { data, error } = await sb.from("mixmatch_categories").select("*").eq("organizer_id", organizerId).limit(500);
      if (error) throw error;
      return (data || []).map(r => ({ id: r.id, name: r.name || "Category", color: r.color || null }));
    } catch (e) { Log.error("player", "Cloud fetchMixCategories failed", { message: e?.message }); return []; }
  },
  async upsertMixCategory(cat, organizerId) {
    const sb = await getSupabase(); if (!sb || !cat || !cat.id || !organizerId) return;
    try {
      await sb.from("mixmatch_categories").upsert({
        id: cat.id, organizer_id: organizerId, name: cat.name || "Category", color: cat.color || null,
        updated_at: new Date().toISOString(),
      });
    } catch (e) { Log.error("player", "Cloud upsertMixCategory failed", { message: e?.message }); }
  },
  async deleteMixCategory(id) {
    const sb = await getSupabase(); if (!sb || !id) return;
    try { await sb.from("mixmatch_categories").delete().eq("id", id); }
    catch (e) { Log.error("player", "Cloud deleteMixCategory failed", { message: e?.message }); }
  },

  // ---- Player <-> Category links (many-to-many; a player can belong to multiple categories) ----
  async fetchMixCategoryLinks(organizerId) {
    const sb = await getSupabase(); if (!sb || !organizerId) return [];
    try {
      const { data, error } = await sb.from("mixmatch_category_players").select("*").eq("organizer_id", organizerId).limit(5000);
      if (error) throw error;
      return (data || []).map(r => ({ categoryId: r.category_id, playerId: r.player_id }));
    } catch (e) { Log.error("player", "Cloud fetchMixCategoryLinks failed", { message: e?.message }); return []; }
  },
  async addCategoryPlayer(categoryId, playerId, organizerId) {
    const sb = await getSupabase(); if (!sb || !categoryId || !playerId || !organizerId) return;
    try { await sb.from("mixmatch_category_players").upsert({ category_id: categoryId, player_id: playerId, organizer_id: organizerId }); }
    catch (e) { Log.error("player", "Cloud addCategoryPlayer failed", { message: e?.message }); }
  },
  async removeCategoryPlayer(categoryId, playerId) {
    const sb = await getSupabase(); if (!sb || !categoryId || !playerId) return;
    try { await sb.from("mixmatch_category_players").delete().eq("category_id", categoryId).eq("player_id", playerId); }
    catch (e) { Log.error("player", "Cloud removeCategoryPlayer failed", { message: e?.message }); }
  },

  // ---- Organizer Teams (tournament-style grouping, distinct from in-match Team A/B) ----
  async fetchMixTeams(organizerId) {
    const sb = await getSupabase(); if (!sb || !organizerId) return [];
    try {
      const { data, error } = await sb.from("mixmatch_teams").select("*").eq("organizer_id", organizerId).limit(500);
      if (error) throw error;
      return (data || []).map(r => ({ id: r.id, name: r.name || "Team", color: r.color || null, logo: r.logo || null }));
    } catch (e) { Log.error("player", "Cloud fetchMixTeams failed", { message: e?.message }); return []; }
  },
  async upsertMixTeam(team, organizerId) {
    const sb = await getSupabase(); if (!sb || !team || !team.id || !organizerId) return;
    try {
      await sb.from("mixmatch_teams").upsert({
        id: team.id, organizer_id: organizerId, name: team.name || "Team", color: team.color || null, logo: team.logo || null,
        updated_at: new Date().toISOString(),
      });
    } catch (e) { Log.error("player", "Cloud upsertMixTeam failed", { message: e?.message }); }
  },
  async deleteMixTeam(id) {
    const sb = await getSupabase(); if (!sb || !id) return;
    try { await sb.from("mixmatch_teams").delete().eq("id", id); }
    catch (e) { Log.error("player", "Cloud deleteMixTeam failed", { message: e?.message }); }
  },

  // ---- Courts (organizer-scoped, shared the same way as mixmatch_teams) ----
  async fetchCourts(organizerId) {
    const sb = await getSupabase(); if (!sb || !organizerId) return [];
    try {
      const { data, error } = await sb.from("courts").select("*").eq("organizer_id", organizerId).limit(200);
      if (error) throw error;
      return (data || []).map(r => ({ id: r.id, name: r.name || "Court", color: r.color || null, active: r.active !== false, status: r.status || "available" }));
    } catch (e) { Log.error("player", "Cloud fetchCourts failed", { message: e?.message }); return []; }
  },
  // Additive alongside upsertCourt/active — the casual CourtMgrModal.jsx flow never
  // touches this column (Supabase upsert only sets columns present in the payload, so
  // upsertCourt below never clobbers it). Scoped to a targeted patch, not upsertCourt's
  // full-row shape, since this is the only field the Tournament Module's Court
  // Management UI needs to change.
  async updateCourtStatus(id, status) {
    const sb = await getSupabase(); if (!sb || !id || !status) return false;
    try {
      const { error } = await sb.from("courts").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
      return true;
    } catch (e) { Log.error("player", "Cloud updateCourtStatus failed", { message: e?.message }); return false; }
  },
  async upsertCourt(court, organizerId) {
    const sb = await getSupabase(); if (!sb || !court || !court.id || !organizerId) return;
    try {
      await sb.from("courts").upsert({
        id: court.id, organizer_id: organizerId, name: court.name || "Court", color: court.color || null,
        active: court.active !== false, updated_at: new Date().toISOString(),
      });
    } catch (e) { Log.error("player", "Cloud upsertCourt failed", { message: e?.message }); }
  },
  async deleteCourt(id) {
    const sb = await getSupabase(); if (!sb || !id) return;
    try { await sb.from("courts").delete().eq("id", id); }
    catch (e) { Log.error("player", "Cloud deleteCourt failed", { message: e?.message }); }
  },

  // ==========================================================================
  // TOURNAMENT MODULE (foundation phase) — tournaments / tournament_divisions /
  // tournament_registrations / tournament_matches. Same shape/conventions as the
  // events CRUD above: explicit row-mappers shared by fetch + realtime, patch
  // objects only touch the keys they're given, best-effort/never-throw.
  // ==========================================================================
  _mapTournamentRow(r) {
    if (!r) return null;
    return {
      id: r.id, name: r.name, logoUrl: r.logo_url || null, bannerUrl: r.banner_url || null,
      venue: r.venue || "", types: Array.isArray(r.types) ? r.types : [],
      startDate: r.start_date, endDate: r.end_date,
      ownerId: r.owner_id, ownerName: r.owner_name || "",
      organizerIds: Array.isArray(r.organizer_ids) ? r.organizer_ids : [],
      organizerNames: r.organizer_names || {},
      status: r.status || "draft", description: r.description || "",
      createdAt: r.created_at, updatedAt: r.updated_at, remote: true,
    };
  },
  async fetchTournaments() {
    const sb = await getSupabase(); if (!sb) return [];
    try {
      const { data, error } = await sb.from("tournaments").select("*").order("start_date", { ascending: false }).limit(200);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapTournamentRow(r));
    } catch (e) { Log.error("system", "Cloud fetchTournaments failed", { message: e?.message }); return []; }
  },
  async createTournament(t) {
    const sb = await getSupabase(); if (!sb || !t?.id) return false;
    try {
      // See createEvent's comment — Outbox-retried, so insert-or-ignore instead of a plain
      // insert (otherwise a lost/ambiguous response to a successful insert 409s forever).
      const { error } = await sb.from("tournaments").upsert({
        id: t.id, name: t.name, logo_url: t.logoUrl || null, banner_url: t.bannerUrl || null,
        venue: t.venue || null, types: t.types || [],
        start_date: t.startDate || null, end_date: t.endDate || null,
        owner_id: t.ownerId, owner_name: t.ownerName || null,
        status: t.status || "draft", description: t.description || null,
      }, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud createTournament failed", { message: e?.message }); return false; }
  },
  async updateTournament(id, patch) {
    const sb = await getSupabase(); if (!sb || !id || !patch) return false;
    try {
      const row = { updated_at: new Date().toISOString() };
      if ("name" in patch) row.name = patch.name;
      if ("logoUrl" in patch) row.logo_url = patch.logoUrl;
      if ("bannerUrl" in patch) row.banner_url = patch.bannerUrl;
      if ("types" in patch) row.types = patch.types;
      if ("venue" in patch) row.venue = patch.venue;
      if ("startDate" in patch) row.start_date = patch.startDate;
      if ("endDate" in patch) row.end_date = patch.endDate;
      if ("status" in patch) row.status = patch.status;
      if ("description" in patch) row.description = patch.description;
      if ("organizerIds" in patch) row.organizer_ids = patch.organizerIds;
      if ("organizerNames" in patch) row.organizer_names = patch.organizerNames;
      const { error } = await sb.from("tournaments").update(row).eq("id", id);
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud updateTournament failed", { message: e?.message }); return false; }
  },
  async deleteTournament(id) {
    const sb = await getSupabase(); if (!sb || !id) return false;
    try { const { error } = await sb.from("tournaments").delete().eq("id", id); if (error) throw error; return true; }
    catch (e) { Log.error("system", "Cloud deleteTournament failed", { message: e?.message }); return false; }
  },

  _mapDivisionRow(r) {
    if (!r) return null;
    return {
      id: r.id, tournamentId: r.tournament_id, organizerId: r.organizer_id,
      name: r.name, category: r.category || "", skillLevel: r.skill_level || "",
      isDoubles: r.is_doubles !== false, format: r.format,
      winTo: r.win_to || 11, bestOf: r.best_of || 1,
      winBy: r.win_by || "two", timeoutsAllowed: r.timeouts_allowed ?? null,
      status: r.status || "pending", seedOrder: Array.isArray(r.seed_order) ? r.seed_order : null,
      hasBronzeMatch: !!r.has_bronze_match, top4Playoffs: !!r.top4_playoffs,
      poolCount: r.pool_count ?? null, poolAdvanceCount: r.pool_advance_count ?? null,
      poolKnockoutFormat: r.pool_knockout_format || null,
      duprRated: !!r.dupr_rated,
      sameTeamMatchupPolicy: r.same_team_matchup_policy || "never",
      eliminationParticipantMode: r.elimination_participant_mode || "all",
      eliminationParticipantCount: r.elimination_participant_count ?? null,
      manualQualifierIds: Array.isArray(r.elimination_manual_qualifier_ids) ? r.elimination_manual_qualifier_ids : null,
      createdAt: r.created_at, updatedAt: r.updated_at, remote: true,
    };
  },
  async fetchDivisions(tournamentId) {
    const sb = await getSupabase(); if (!sb || !tournamentId) return [];
    try {
      const { data, error } = await sb.from("tournament_divisions").select("*").eq("tournament_id", tournamentId).limit(100);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapDivisionRow(r));
    } catch (e) { Log.error("system", "Cloud fetchDivisions failed", { message: e?.message }); return []; }
  },
  // Singular fetch — used by advanceTournamentBracket's round-robin-complete trigger, which
  // only has a divisionId in scope (no already-loaded division list to search).
  async fetchDivision(id) {
    const sb = await getSupabase(); if (!sb || !id) return null;
    try {
      const { data, error } = await sb.from("tournament_divisions").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return Cloud._mapDivisionRow(data);
    } catch (e) { Log.error("system", "Cloud fetchDivision failed", { message: e?.message }); return null; }
  },
  async createDivision(d) {
    const sb = await getSupabase(); if (!sb || !d?.id) return false;
    try {
      // See createEvent's comment — Outbox-retried, so insert-or-ignore instead of a plain
      // insert (otherwise a lost/ambiguous response to a successful insert 409s forever).
      const { error } = await sb.from("tournament_divisions").upsert({
        id: d.id, tournament_id: d.tournamentId, organizer_id: d.organizerId,
        name: d.name, category: d.category || null, skill_level: d.skillLevel || null,
        is_doubles: d.isDoubles !== false, format: d.format,
        win_to: d.winTo || 11, best_of: d.bestOf || 1, status: d.status || "pending",
        win_by: d.winBy || "two", timeouts_allowed: d.timeoutsAllowed ?? null,
        has_bronze_match: !!d.hasBronzeMatch, top4_playoffs: !!d.top4Playoffs,
        pool_count: d.poolCount ?? null, pool_advance_count: d.poolAdvanceCount ?? null,
        pool_knockout_format: d.poolKnockoutFormat || null,
        dupr_rated: !!d.duprRated,
        same_team_matchup_policy: d.sameTeamMatchupPolicy || "never",
        elimination_participant_mode: d.eliminationParticipantMode || "all",
        elimination_participant_count: d.eliminationParticipantCount ?? null,
        elimination_manual_qualifier_ids: d.manualQualifierIds ?? null,
      }, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud createDivision failed", { message: e?.message }); return false; }
  },
  async updateDivision(id, patch) {
    const sb = await getSupabase(); if (!sb || !id || !patch) return false;
    try {
      const row = { updated_at: new Date().toISOString() };
      if ("name" in patch) row.name = patch.name;
      if ("category" in patch) row.category = patch.category;
      if ("skillLevel" in patch) row.skill_level = patch.skillLevel;
      if ("isDoubles" in patch) row.is_doubles = patch.isDoubles;
      if ("format" in patch) row.format = patch.format;
      if ("winTo" in patch) row.win_to = patch.winTo;
      if ("bestOf" in patch) row.best_of = patch.bestOf;
      if ("winBy" in patch) row.win_by = patch.winBy;
      if ("timeoutsAllowed" in patch) row.timeouts_allowed = patch.timeoutsAllowed;
      if ("status" in patch) row.status = patch.status;
      if ("seedOrder" in patch) row.seed_order = patch.seedOrder;
      if ("hasBronzeMatch" in patch) row.has_bronze_match = patch.hasBronzeMatch;
      if ("top4Playoffs" in patch) row.top4_playoffs = patch.top4Playoffs;
      if ("poolCount" in patch) row.pool_count = patch.poolCount;
      if ("poolAdvanceCount" in patch) row.pool_advance_count = patch.poolAdvanceCount;
      if ("poolKnockoutFormat" in patch) row.pool_knockout_format = patch.poolKnockoutFormat;
      if ("duprRated" in patch) row.dupr_rated = patch.duprRated;
      if ("sameTeamMatchupPolicy" in patch) row.same_team_matchup_policy = patch.sameTeamMatchupPolicy;
      if ("eliminationParticipantMode" in patch) row.elimination_participant_mode = patch.eliminationParticipantMode;
      if ("eliminationParticipantCount" in patch) row.elimination_participant_count = patch.eliminationParticipantCount;
      if ("manualQualifierIds" in patch) row.elimination_manual_qualifier_ids = patch.manualQualifierIds;
      const { error } = await sb.from("tournament_divisions").update(row).eq("id", id);
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud updateDivision failed", { message: e?.message }); return false; }
  },
  async deleteDivision(id) {
    const sb = await getSupabase(); if (!sb || !id) return false;
    try { const { error } = await sb.from("tournament_divisions").delete().eq("id", id); if (error) throw error; return true; }
    catch (e) { Log.error("system", "Cloud deleteDivision failed", { message: e?.message }); return false; }
  },

  // Pool Play / Pool-to-Knockout groups — mirrors createDivision/fetchDivisions/
  // subscribeDivisions exactly (same organizer_id-denormalized-from-owner RLS pattern).
  _mapPoolRow(r) {
    if (!r) return null;
    return {
      id: r.id, tournamentId: r.tournament_id, divisionId: r.division_id, organizerId: r.organizer_id,
      name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, remote: true,
    };
  },
  async fetchPools(divisionId) {
    const sb = await getSupabase(); if (!sb || !divisionId) return [];
    try {
      const { data, error } = await sb.from("tournament_pools").select("*").eq("division_id", divisionId).limit(100);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapPoolRow(r));
    } catch (e) { Log.error("system", "Cloud fetchPools failed", { message: e?.message }); return []; }
  },
  async createPool(p) {
    const sb = await getSupabase(); if (!sb || !p?.id) return false;
    try {
      // See createEvent's comment — Outbox-retried, so insert-or-ignore instead of a plain
      // insert (otherwise a lost/ambiguous response to a successful insert 409s forever).
      const { error } = await sb.from("tournament_pools").upsert({
        id: p.id, tournament_id: p.tournamentId, division_id: p.divisionId, organizer_id: p.organizerId, name: p.name,
      }, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud createPool failed", { message: e?.message }); return false; }
  },
  async subscribePools(divisionId, onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("tournament_pools_" + divisionId)
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_pools", filter: "division_id=eq." + divisionId }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapPoolRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribePools failed", { message: e?.message }); return null; }
  },

  // Team Elimination "Team Groups" — mirrors createDivision/fetchDivisions/updateDivision/
  // deleteDivision exactly (persisted, editable/deletable entity, same organizer_id-
  // denormalized-from-owner RLS pattern as tournament_pools). Division-scoped: a team
  // grouping only has meaning relative to one bracket.
  _mapTeamRow(r) {
    if (!r) return null;
    return {
      id: r.id, tournamentId: r.tournament_id, divisionId: r.division_id, organizerId: r.organizer_id,
      name: r.name, color: r.color || null, bracketGroup: r.bracket_group || null,
      createdAt: r.created_at, updatedAt: r.updated_at, remote: true,
    };
  },
  async fetchTeams(divisionId) {
    const sb = await getSupabase(); if (!sb || !divisionId) return [];
    try {
      const { data, error } = await sb.from("tournament_teams").select("*").eq("division_id", divisionId).limit(200);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapTeamRow(r));
    } catch (e) { Log.error("system", "Cloud fetchTeams failed", { message: e?.message }); return []; }
  },
  async createTeam(team) {
    const sb = await getSupabase(); if (!sb || !team?.id) return false;
    try {
      // See createEvent's comment — Outbox-retried, so insert-or-ignore instead of a plain
      // insert (otherwise a lost/ambiguous response to a successful insert 409s forever).
      const { error } = await sb.from("tournament_teams").upsert({
        id: team.id, tournament_id: team.tournamentId, division_id: team.divisionId, organizer_id: team.organizerId,
        name: team.name, color: team.color || null, bracket_group: team.bracketGroup || null,
      }, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud createTeam failed", { message: e?.message }); return false; }
  },
  async updateTeam(id, patch) {
    const sb = await getSupabase(); if (!sb || !id || !patch) return false;
    try {
      const row = { updated_at: new Date().toISOString() };
      if ("name" in patch) row.name = patch.name;
      if ("color" in patch) row.color = patch.color;
      if ("bracketGroup" in patch) row.bracket_group = patch.bracketGroup;
      const { error } = await sb.from("tournament_teams").update(row).eq("id", id);
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud updateTeam failed", { message: e?.message }); return false; }
  },
  async deleteTeam(id) {
    const sb = await getSupabase(); if (!sb || !id) return false;
    try { const { error } = await sb.from("tournament_teams").delete().eq("id", id); if (error) throw error; return true; }
    catch (e) { Log.error("system", "Cloud deleteTeam failed", { message: e?.message }); return false; }
  },
  async subscribeTeams(divisionId, onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("tournament_teams_" + divisionId)
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_teams", filter: "division_id=eq." + divisionId }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapTeamRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeTeams failed", { message: e?.message }); return null; }
  },

  _mapRegistrationRow(r) {
    if (!r) return null;
    return {
      id: r.id, tournamentId: r.tournament_id, divisionId: r.division_id, organizerId: r.organizer_id,
      playerIds: Array.isArray(r.player_ids) ? r.player_ids : [],
      playerNames: r.player_names || {},
      linkedAccountIds: Array.isArray(r.linked_account_ids) ? r.linked_account_ids : [],
      seed: r.seed ?? null, status: r.status || "registered", source: r.source || "manual",
      country: r.country || null, club: r.club || null,
      teamName: r.team_name || null, poolId: r.pool_id || null,
      // teamId: the team_elimination "Team Group" this pair belongs to (see tournament_teams,
      // migration 134) — unrelated to teamName above, which is just this pair's own display name.
      teamId: r.team_id || null,
      playerGenders: r.player_genders || {}, playerAges: r.player_ages || {}, playerDuprRatings: r.player_dupr_ratings || {},
      createdAt: r.created_at, remote: true,
    };
  },
  async fetchRegistrations(divisionId) {
    const sb = await getSupabase(); if (!sb || !divisionId) return [];
    try {
      const { data, error } = await sb.from("tournament_registrations").select("*").eq("division_id", divisionId).limit(500);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapRegistrationRow(r));
    } catch (e) { Log.error("system", "Cloud fetchRegistrations failed", { message: e?.message }); return []; }
  },
  // Tournament-wide (not division-scoped) variant for the Tournament Match History tab —
  // tournament_id is already a denormalized column on every row, same mapper/shape as above.
  async fetchRegistrationsForTournament(tournamentId) {
    const sb = await getSupabase(); if (!sb || !tournamentId) return [];
    try {
      const { data, error } = await sb.from("tournament_registrations").select("*").eq("tournament_id", tournamentId).limit(2000);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapRegistrationRow(r));
    } catch (e) { Log.error("system", "Cloud fetchRegistrationsForTournament failed", { message: e?.message }); return []; }
  },
  async subscribeRegistrationsForTournament(tournamentId, onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("tournament_registrations_tournament_" + tournamentId)
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_registrations", filter: "tournament_id=eq." + tournamentId }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapRegistrationRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeRegistrationsForTournament failed", { message: e?.message }); return null; }
  },
  // Single insert (manual entry) and bulk insert (Excel/CSV import) share the same row shape.
  async createRegistration(r) { return Cloud.bulkCreateRegistrations([r]); },
  async bulkCreateRegistrations(rows) {
    const sb = await getSupabase(); if (!sb || !rows?.length) return false;
    try {
      // See createEvent's comment — Outbox-retried, so insert-or-ignore instead of a plain
      // insert (otherwise a lost/ambiguous response to a successful insert 409s forever).
      const { error } = await sb.from("tournament_registrations").upsert(rows.map(r => ({
        id: r.id, tournament_id: r.tournamentId, division_id: r.divisionId, organizer_id: r.organizerId,
        player_ids: r.playerIds || [], player_names: r.playerNames || {},
        linked_account_ids: r.linkedAccountIds || [], seed: r.seed ?? null,
        status: r.status || "registered", source: r.source || "manual",
        country: r.country || null, club: r.club || null,
        team_name: r.teamName || null, pool_id: r.poolId || null, team_id: r.teamId || null,
        player_genders: r.playerGenders || {}, player_ages: r.playerAges || {}, player_dupr_ratings: r.playerDuprRatings || {},
      })), { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud bulkCreateRegistrations failed", { message: e?.message }); return false; }
  },
  async updateRegistration(id, patch) {
    const sb = await getSupabase(); if (!sb || !id || !patch) return false;
    try {
      const row = {};
      if ("seed" in patch) row.seed = patch.seed;
      if ("status" in patch) row.status = patch.status;
      if ("playerIds" in patch) row.player_ids = patch.playerIds;
      if ("playerNames" in patch) row.player_names = patch.playerNames;
      if ("linkedAccountIds" in patch) row.linked_account_ids = patch.linkedAccountIds;
      if ("country" in patch) row.country = patch.country;
      if ("club" in patch) row.club = patch.club;
      if ("teamName" in patch) row.team_name = patch.teamName;
      if ("poolId" in patch) row.pool_id = patch.poolId;
      if ("teamId" in patch) row.team_id = patch.teamId;
      if ("playerGenders" in patch) row.player_genders = patch.playerGenders;
      if ("playerAges" in patch) row.player_ages = patch.playerAges;
      if ("playerDuprRatings" in patch) row.player_dupr_ratings = patch.playerDuprRatings;
      if (!Object.keys(row).length) return true;
      const { error } = await sb.from("tournament_registrations").update(row).eq("id", id);
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud updateRegistration failed", { message: e?.message }); return false; }
  },
  async deleteRegistration(id) {
    const sb = await getSupabase(); if (!sb || !id) return false;
    try { const { error } = await sb.from("tournament_registrations").delete().eq("id", id); if (error) throw error; return true; }
    catch (e) { Log.error("system", "Cloud deleteRegistration failed", { message: e?.message }); return false; }
  },
  // Best placement (1=champion, 2=runner-up, 3=2nd runner-up) per player id, for
  // tournamentSeeding.js's seedByPreviousResults. Reads tournament_results (added in a
  // later phase) — when writing a champion/runner-up award there, ResultsPanel fans out
  // one row per player on the winning registration (not one row per team), so every award
  // is always individually queryable by player_id here, doubles or singles alike. Safe to
  // call before that table exists: the query errors, gets caught below, and this returns
  // {} exactly like "no prior results," so seeding degrades gracefully instead of breaking.
  async fetchAccountTournamentHistory(accountIds) {
    const sb = await getSupabase(); if (!sb || !accountIds?.length) return {};
    try {
      const { data, error } = await sb.from("tournament_results")
        .select("player_id,award_type")
        .in("player_id", accountIds)
        .in("award_type", ["champion", "runner_up_1", "runner_up_2"]);
      if (error) throw error;
      const RANK = { champion: 1, runner_up_1: 2, runner_up_2: 3 };
      const map = {};
      (data || []).forEach(row => {
        const r = RANK[row.award_type];
        if (r != null && (map[row.player_id] == null || r < map[row.player_id])) map[row.player_id] = r;
      });
      return map;
    } catch (e) { Log.error("system", "Cloud fetchAccountTournamentHistory failed", { message: e?.message }); return {}; }
  },
  // Sync Center's "players missing DUPR ID" check. accounts.dupr_id/dupr_status aren't in
  // the column-level SELECT grant (101_policies_identity.sql restricts direct accounts
  // reads to PII-free columns; DUPR fields are only readable for the caller's own row via
  // my_account()) — this narrow RPC (migration 124) answers just the one boolean fact this
  // feature needs for OTHER players' accounts, without widening that grant.
  async fetchAccountsDuprLinkStatus(accountIds) {
    const sb = await getSupabase(); if (!sb || !accountIds?.length) return {};
    try {
      const { data, error } = await sb.rpc("accounts_dupr_status", { account_ids: accountIds });
      if (error) throw error;
      const map = {};
      (data || []).forEach(r => { map[r.account_id] = !!r.has_dupr_id; });
      return map;
    } catch (e) { Log.error("system", "Cloud fetchAccountsDuprLinkStatus failed", { message: e?.message }); return {}; }
  },

  // Match-dispute / support report — incorrect score, wrong player, incorrect
  // result, or a DUPR submission issue. Direct authenticated insert (RLS-gated
  // to the caller's own reporter_id, migration 133) since this never touches a
  // DUPR secret; purely informational, never modifies the match itself.
  async reportMatchIssue({ reporterId, matchId, duprMatchCode, issueType, description }) {
    const sb = await getSupabase(); if (!sb) return { ok: false, error: "Cloud not available" };
    try {
      const { error } = await sb.from("support_requests").insert({
        reporter_id: reporterId, match_id: matchId || null, dupr_match_code: duprMatchCode || null,
        issue_type: issueType, description: description || null,
      });
      if (error) throw error;
      return { ok: true };
    } catch (e) { Log.error("system", "Cloud reportMatchIssue failed", { message: e?.message }); return { ok: false, error: e?.message || "Request failed" }; }
  },

  // Results — Champion/Runner-up/2nd Runner-up (division_id set) and MVP/Best
  // Sportsmanship (division_id null = tournament-wide) awards. ResultsPanel.jsx fans out
  // one row per player on a winning registration for champion/runner-up (not one row per
  // team) so player_id is always populated regardless of award type — see migration 123.
  _mapResultRow(r) {
    if (!r) return null;
    return {
      id: r.id, tournamentId: r.tournament_id, divisionId: r.division_id || null, organizerId: r.organizer_id,
      awardType: r.award_type, registrationId: r.registration_id || null,
      playerId: r.player_id || null, playerName: r.player_name || null, notes: r.notes || null,
      createdAt: r.created_at, updatedAt: r.updated_at, remote: true,
    };
  },
  async fetchTournamentResults(tournamentId) {
    const sb = await getSupabase(); if (!sb || !tournamentId) return [];
    try {
      const { data, error } = await sb.from("tournament_results").select("*").eq("tournament_id", tournamentId).limit(200);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapResultRow(r));
    } catch (e) { Log.error("system", "Cloud fetchTournamentResults failed", { message: e?.message }); return []; }
  },
  async upsertTournamentResult(result) {
    const sb = await getSupabase(); if (!sb || !result?.id) return false;
    try {
      const { error } = await sb.from("tournament_results").upsert({
        id: result.id, tournament_id: result.tournamentId, division_id: result.divisionId || null,
        organizer_id: result.organizerId, award_type: result.awardType,
        registration_id: result.registrationId || null, player_id: result.playerId || null,
        player_name: result.playerName || null, notes: result.notes || null,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud upsertTournamentResult failed", { message: e?.message }); return false; }
  },
  async deleteTournamentResult(id) {
    const sb = await getSupabase(); if (!sb || !id) return false;
    try {
      const { error } = await sb.from("tournament_results").delete().eq("id", id);
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud deleteTournamentResult failed", { message: e?.message }); return false; }
  },
  async subscribeTournamentResults(tournamentId, onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("tournament_results_" + tournamentId)
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_results", filter: "tournament_id=eq." + tournamentId }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapResultRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeTournamentResults failed", { message: e?.message }); return null; }
  },

  // Team Elimination "Team Matchups" — the true bracket unit for team_elimination
  // (a "Team A vs Team B" card). Mirrors the tournament_teams CRUD block above
  // exactly. Individual pair matches (tournament_matches rows, below) link to a
  // matchup via team_matchup_id/pair_slot — those two columns are set once at
  // creation and never patched afterward, same convention next_match_id/
  // next_match_slot already follow on tournament_matches itself.
  _mapTeamMatchupRow(r) {
    if (!r) return null;
    return {
      id: r.id, tournamentId: r.tournament_id, divisionId: r.division_id, organizerId: r.organizer_id,
      round: r.round, bracketPosition: r.bracket_position ?? null,
      teamAId: r.team_a_id || null, teamBId: r.team_b_id || null,
      pairAId: r.pair_a_id || null, pairBId: r.pair_b_id || null,
      teamAWins: r.team_a_wins || 0, teamBWins: r.team_b_wins || 0,
      pairsPerMatchup: r.pairs_per_matchup, winnerTeamId: r.winner_team_id || null,
      status: r.status || "pending",
      nextMatchupId: r.next_matchup_id || null, nextMatchupSlot: r.next_matchup_slot || null,
      bracketSide: r.bracket_side || null,
      loserNextMatchupId: r.loser_next_matchup_id || null, loserNextMatchupSlot: r.loser_next_matchup_slot || null,
      bracketGroup: r.bracket_group || null, stageLabel: r.stage_label || null,
      mergeGroupA: r.merge_group_a || null, mergeGroupB: r.merge_group_b || null,
      stage: r.stage || null,
      createdAt: r.created_at, updatedAt: r.updated_at, remote: true,
    };
  },
  async fetchTeamMatchups(divisionId) {
    const sb = await getSupabase(); if (!sb || !divisionId) return [];
    try {
      const { data, error } = await sb.from("tournament_team_matchups").select("*").eq("division_id", divisionId).order("round", { ascending: true }).limit(500);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapTeamMatchupRow(r));
    } catch (e) { Log.error("system", "Cloud fetchTeamMatchups failed", { message: e?.message }); return []; }
  },
  // Bulk insert for "Generate Bracket" — one call, whole division's team-matchup shell set.
  async bulkCreateTeamMatchups(rows) {
    const sb = await getSupabase(); if (!sb || !rows?.length) return false;
    try {
      // See createEvent's comment — Outbox-retried, so insert-or-ignore instead of a plain
      // insert (otherwise a lost/ambiguous response to a successful insert 409s forever).
      const { error } = await sb.from("tournament_team_matchups").upsert(rows.map(m => ({
        id: m.id, tournament_id: m.tournamentId, division_id: m.divisionId, organizer_id: m.organizerId,
        round: m.round, bracket_position: m.bracketPosition ?? null,
        team_a_id: m.teamAId || null, team_b_id: m.teamBId || null,
        pair_a_id: m.pairAId || null, pair_b_id: m.pairBId || null,
        team_a_wins: m.teamAWins || 0, team_b_wins: m.teamBWins || 0,
        pairs_per_matchup: m.pairsPerMatchup, winner_team_id: m.winnerTeamId || null,
        status: m.status || "pending",
        next_matchup_id: m.nextMatchupId || null, next_matchup_slot: m.nextMatchupSlot || null,
        bracket_side: m.bracketSide || null,
        loser_next_matchup_id: m.loserNextMatchupId || null, loser_next_matchup_slot: m.loserNextMatchupSlot || null,
        bracket_group: m.bracketGroup || null, stage_label: m.stageLabel || null,
        merge_group_a: m.mergeGroupA || null, merge_group_b: m.mergeGroupB || null,
        stage: m.stage || null,
      })), { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud bulkCreateTeamMatchups failed", { message: e?.message }); return false; }
  },
  // Bracket regeneration only — caller (hasKnockoutStageStarted, tournamentTeamPlayoffs.js)
  // must confirm nothing among `ids` has started before this is ever enqueued. Migration
  // 136's team_matchup_id FK is ON DELETE CASCADE, so each matchup's own child
  // tournament_matches row (its single pair-vs-pair match) is removed automatically —
  // no second delete call needed.
  async deleteTeamMatchupsBulk(ids) {
    const sb = await getSupabase(); if (!sb || !ids?.length) return false;
    try {
      const { error } = await sb.from("tournament_team_matchups").delete().in("id", ids);
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud deleteTeamMatchupsBulk failed", { message: e?.message }); return false; }
  },
  async updateTeamMatchup(id, patch) {
    const sb = await getSupabase(); if (!sb || !id || !patch) return false;
    try {
      const row = { updated_at: new Date().toISOString() };
      if ("teamAId" in patch) row.team_a_id = patch.teamAId;
      if ("teamBId" in patch) row.team_b_id = patch.teamBId;
      if ("pairAId" in patch) row.pair_a_id = patch.pairAId;
      if ("pairBId" in patch) row.pair_b_id = patch.pairBId;
      if ("teamAWins" in patch) row.team_a_wins = patch.teamAWins;
      if ("teamBWins" in patch) row.team_b_wins = patch.teamBWins;
      if ("winnerTeamId" in patch) row.winner_team_id = patch.winnerTeamId;
      if ("status" in patch) row.status = patch.status;
      if ("stage" in patch) row.stage = patch.stage;
      if (!Object.keys(row).length) return true;
      const { error } = await sb.from("tournament_team_matchups").update(row).eq("id", id);
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud updateTeamMatchup failed", { message: e?.message }); return false; }
  },
  async subscribeTeamMatchups(divisionId, onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("tournament_team_matchups_" + divisionId)
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_team_matchups", filter: "division_id=eq." + divisionId }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapTeamMatchupRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeTeamMatchups failed", { message: e?.message }); return null; }
  },

  _mapTournamentMatchRow(r) {
    if (!r) return null;
    return {
      id: r.id, tournamentId: r.tournament_id, divisionId: r.division_id, organizerId: r.organizer_id,
      round: r.round, roundLabel: r.round_label || null, bracketPosition: r.bracket_position ?? null,
      registrationAId: r.registration_a_id || null, registrationBId: r.registration_b_id || null,
      courtId: r.court_id || null, status: r.status || "pending", winner: r.winner || null,
      score: r.score || null, liveMatchId: r.live_match_id || null,
      completedMatchId: r.completed_match_id || null,
      nextMatchId: r.next_match_id || null, nextMatchSlot: r.next_match_slot || null,
      bracketSide: r.bracket_side || null,
      loserNextMatchId: r.loser_next_match_id || null, loserNextMatchSlot: r.loser_next_match_slot || null,
      phantomSlot: r.phantom_slot || null, poolId: r.pool_id || null, refereeName: r.referee_name || null,
      umpireId: r.umpire_id || null, umpireName: r.umpire_name || null,
      umpireAssignedAt: r.umpire_assigned_at || null, umpireLastSeenAt: r.umpire_last_seen_at || null,
      teamMatchupId: r.team_matchup_id || null, pairSlot: r.pair_slot ?? null,
      createdAt: r.created_at, updatedAt: r.updated_at, remote: true,
    };
  },
  async fetchTournamentMatches(divisionId) {
    const sb = await getSupabase(); if (!sb || !divisionId) return [];
    try {
      const { data, error } = await sb.from("tournament_matches").select("*").eq("division_id", divisionId).order("round", { ascending: true }).limit(1000);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapTournamentMatchRow(r));
    } catch (e) { Log.error("system", "Cloud fetchTournamentMatches failed", { message: e?.message }); return []; }
  },
  // Tournament-wide (not division-scoped) variant for the Tournament Overview/Courts tabs —
  // tournament_id is already a denormalized column on every row, same mapper/shape as above.
  async fetchTournamentMatchesForTournament(tournamentId) {
    const sb = await getSupabase(); if (!sb || !tournamentId) return [];
    try {
      const { data, error } = await sb.from("tournament_matches").select("*").eq("tournament_id", tournamentId).order("round", { ascending: true }).limit(2000);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapTournamentMatchRow(r));
    } catch (e) { Log.error("system", "Cloud fetchTournamentMatchesForTournament failed", { message: e?.message }); return []; }
  },
  // Singular fetch — used by a match_assigned notification's deep-link, which only has a
  // matchId in scope (no already-loaded division/tournament match list to search, since the
  // tapping player may not have that division open, or even be an organizer/umpire).
  async fetchTournamentMatch(id) {
    const sb = await getSupabase(); if (!sb || !id) return null;
    try {
      const { data, error } = await sb.from("tournament_matches").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return Cloud._mapTournamentMatchRow(data);
    } catch (e) { Log.error("system", "Cloud fetchTournamentMatch failed", { message: e?.message }); return null; }
  },
  async subscribeTournamentMatchesForTournament(tournamentId, onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("tournament_matches_tournament_" + tournamentId)
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_matches", filter: "tournament_id=eq." + tournamentId }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapTournamentMatchRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeTournamentMatchesForTournament failed", { message: e?.message }); return null; }
  },
  // Bulk insert for "Generate Schedule"/"Generate Bracket" — one call, whole division's match set.
  async bulkCreateTournamentMatches(rows) {
    const sb = await getSupabase(); if (!sb || !rows?.length) return false;
    try {
      // See createEvent's comment — Outbox-retried, so insert-or-ignore instead of a plain
      // insert (otherwise a lost/ambiguous response to a successful insert 409s forever).
      const { error } = await sb.from("tournament_matches").upsert(rows.map(m => ({
        id: m.id, tournament_id: m.tournamentId, division_id: m.divisionId, organizer_id: m.organizerId,
        round: m.round, round_label: m.roundLabel || null, bracket_position: m.bracketPosition ?? null,
        registration_a_id: m.registrationAId || null, registration_b_id: m.registrationBId || null,
        status: m.status || "pending", winner: m.winner || null,
        next_match_id: m.nextMatchId || null, next_match_slot: m.nextMatchSlot || null,
        bracket_side: m.bracketSide || null,
        loser_next_match_id: m.loserNextMatchId || null, loser_next_match_slot: m.loserNextMatchSlot || null,
        phantom_slot: m.phantomSlot || null, pool_id: m.poolId || null,
        team_matchup_id: m.teamMatchupId || null, pair_slot: m.pairSlot ?? null,
      })), { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud bulkCreateTournamentMatches failed", { message: e?.message }); return false; }
  },
  async updateTournamentMatch(id, patch) {
    const sb = await getSupabase(); if (!sb || !id || !patch) return false;
    try {
      const row = { updated_at: new Date().toISOString() };
      if ("registrationAId" in patch) row.registration_a_id = patch.registrationAId;
      if ("registrationBId" in patch) row.registration_b_id = patch.registrationBId;
      if ("courtId" in patch) row.court_id = patch.courtId;
      if ("status" in patch) row.status = patch.status;
      if ("winner" in patch) row.winner = patch.winner;
      if ("score" in patch) row.score = patch.score;
      if ("liveMatchId" in patch) row.live_match_id = patch.liveMatchId;
      if ("completedMatchId" in patch) row.completed_match_id = patch.completedMatchId;
      if ("bracketSide" in patch) row.bracket_side = patch.bracketSide;
      if ("loserNextMatchId" in patch) row.loser_next_match_id = patch.loserNextMatchId;
      if ("loserNextMatchSlot" in patch) row.loser_next_match_slot = patch.loserNextMatchSlot;
      if ("phantomSlot" in patch) row.phantom_slot = patch.phantomSlot;
      if ("refereeName" in patch) row.referee_name = patch.refereeName;
      if ("umpireId" in patch) row.umpire_id = patch.umpireId;
      if ("umpireName" in patch) row.umpire_name = patch.umpireName;
      if ("umpireAssignedAt" in patch) row.umpire_assigned_at = patch.umpireAssignedAt;
      if ("umpireLastSeenAt" in patch) row.umpire_last_seen_at = patch.umpireLastSeenAt;
      if (!Object.keys(row).length) return true;
      const { error } = await sb.from("tournament_matches").update(row).eq("id", id);
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud updateTournamentMatch failed", { message: e?.message }); return false; }
  },
  // Applies several tournament_matches patches at once (e.g. court auto-assign,
  // or double-elimination advancement writing to both the winner's next match
  // and the loser's losers-bracket destination in one call). Succeeds only if
  // every individual patch succeeded, so Outbox retries the whole batch on any
  // partial failure rather than silently losing just one of the patches.
  async bulkUpdateTournamentMatches(patches) {
    if (!patches?.length) return true;
    const results = await Promise.all(patches.map(p => Cloud.updateTournamentMatch(p.matchId, p.patch)));
    return results.every(Boolean);
  },
  // Realtime bracket/schedule progression — mirrors subscribeEventsChanges exactly.
  async subscribeTournamentMatches(divisionId, onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("tournament_matches_" + divisionId)
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_matches", filter: "division_id=eq." + divisionId }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapTournamentMatchRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeTournamentMatches failed", { message: e?.message }); return null; }
  },
  // Same pattern as subscribeTournamentMatches, unfiltered — the tournaments list is visible to
  // every authenticated user (SELECT RLS is `using(true)`), so every organizer's create/edit
  // shows up live on every device instead of only after that device's own next re-fetch.
  async subscribeTournaments(onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("tournaments_changes")
        .on("postgres_changes", { event: "*", schema: "public", table: "tournaments" }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapTournamentRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeTournaments failed", { message: e?.message }); return null; }
  },
  async subscribeDivisions(tournamentId, onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("tournament_divisions_" + tournamentId)
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_divisions", filter: "tournament_id=eq." + tournamentId }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapDivisionRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeDivisions failed", { message: e?.message }); return null; }
  },
  async subscribeRegistrations(divisionId, onChange) {
    const sb = await getSupabase(); if (!sb) return null;
    try {
      const channel = sb.channel("tournament_registrations_" + divisionId)
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_registrations", filter: "division_id=eq." + divisionId }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapRegistrationRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeRegistrations failed", { message: e?.message }); return null; }
  },

  // Umpire audit trail — durable, cross-device (unlike src/lib/log.js's local-only ring
  // buffer). Fire-and-forget, never throws, NOT outbox-queued: this is a supplementary
  // trail, not source-of-truth match data, so a dropped entry during a network blip is
  // an acceptable trade-off against queuing a write for every single point scored.
  async appendAuditLog({ tournamentMatchId, liveMatchId, organizerId, actorId, actorName, action, detail }) {
    const sb = await getSupabase(); if (!sb || !tournamentMatchId || !actorId || !action) return false;
    try {
      const { error } = await sb.from("match_audit_log").insert({
        id: "aud_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        tournament_match_id: tournamentMatchId, live_match_id: liveMatchId || null,
        organizer_id: organizerId, actor_id: actorId, actor_name: actorName || null,
        action, detail: detail || null,
      });
      if (error) throw error;
      return true;
    } catch (e) { Log.error("system", "Cloud appendAuditLog failed", { message: e?.message }); return false; }
  },
  async fetchAuditLog(tournamentMatchId) {
    const sb = await getSupabase(); if (!sb || !tournamentMatchId) return [];
    try {
      const { data, error } = await sb.from("match_audit_log").select("*").eq("tournament_match_id", tournamentMatchId).order("created_at", { ascending: true }).limit(500);
      if (error) throw error;
      return (data || []).map(r => ({
        id: r.id, tournamentMatchId: r.tournament_match_id, liveMatchId: r.live_match_id,
        actorId: r.actor_id, actorName: r.actor_name, action: r.action, detail: r.detail || null, createdAt: r.created_at,
      }));
    } catch (e) { Log.error("system", "Cloud fetchAuditLog failed", { message: e?.message }); return []; }
  },

  // Umpire's own assigned matches, tournament-wide (not division-scoped) — reads/
  // subscribes tournament_matches filtered on umpire_id, already a realtime-published
  // table (migration 117), so no new publication entry is needed for this.
  async fetchMyUmpireAssignments(userId) {
    const sb = await getSupabase(); if (!sb || !userId) return [];
    try {
      const { data, error } = await sb.from("tournament_matches").select("*").eq("umpire_id", userId).order("updated_at", { ascending: false }).limit(200);
      if (error) throw error;
      return (data || []).map(r => Cloud._mapTournamentMatchRow(r));
    } catch (e) { Log.error("system", "Cloud fetchMyUmpireAssignments failed", { message: e?.message }); return []; }
  },
  async subscribeMyUmpireAssignments(userId, onChange) {
    const sb = await getSupabase(); if (!sb || !userId) return null;
    try {
      const channel = sb.channel("tournament_matches_umpire_" + userId)
        .on("postgres_changes", { event: "*", schema: "public", table: "tournament_matches", filter: "umpire_id=eq." + userId }, (payload) => {
          try {
            const row = payload.eventType === "DELETE" ? payload.old : payload.new;
            const mapped = Cloud._mapTournamentMatchRow(row);
            if (mapped && onChange) onChange(mapped, payload.eventType);
          } catch{ /* best-effort, safe to ignore */ }
        })
        .subscribe();
      return channel;
    } catch (e) { Log.error("system", "Cloud subscribeMyUmpireAssignments failed", { message: e?.message }); return null; }
  },
};

// Outbox handler registry — kept separate from Outbox's own definition (above) since it needs
// `Cloud` to exist first. Every handler returns true/false so Outbox.drain() knows whether to
// remove or retry an item.
const OUTBOX_HANDLERS = {
  upsertMatch: (payload) => Cloud.upsertMatch(payload.match),
  upsertMixPlayer: (payload) => Cloud.upsertMixPlayer(payload.player, payload.organizerId),
  recordRatingHistory: (payload) => Cloud.recordRatingHistory(payload.row),
  deleteLiveMatch: (payload) => Cloud.deleteLiveMatch(payload.id),
  createMatchOrganizerInvite: (payload) => Cloud.createMatchOrganizerInvite(payload.invite),
  upsertLiveMatch: (payload) => Cloud.upsertLiveMatch(payload.match),
  createEvent: (payload) => Cloud.createEvent(payload.event),
  createTournament: (payload) => Cloud.createTournament(payload.tournament),
  updateTournament: (payload) => Cloud.updateTournament(payload.id, payload.patch),
  deleteTournament: (payload) => Cloud.deleteTournament(payload.id),
  createDivision: (payload) => Cloud.createDivision(payload.division),
  updateDivision: (payload) => Cloud.updateDivision(payload.id, payload.patch),
  deleteDivision: (payload) => Cloud.deleteDivision(payload.id),
  createPool: (payload) => Cloud.createPool(payload.pool),
  createTeam: (payload) => Cloud.createTeam(payload.team),
  updateTeam: (payload) => Cloud.updateTeam(payload.id, payload.patch),
  deleteTeam: (payload) => Cloud.deleteTeam(payload.id),
  updateCourtStatus: (payload) => Cloud.updateCourtStatus(payload.id, payload.status),
  upsertTournamentResult: (payload) => Cloud.upsertTournamentResult(payload.result),
  bulkCreateRegistrations: (payload) => Cloud.bulkCreateRegistrations(payload.rows),
  updateRegistration: (payload) => Cloud.updateRegistration(payload.id, payload.patch),
  deleteRegistration: (payload) => Cloud.deleteRegistration(payload.id),
  bulkCreateTournamentMatches: (payload) => Cloud.bulkCreateTournamentMatches(payload.rows),
  updateTournamentMatch: (payload) => Cloud.updateTournamentMatch(payload.id, payload.patch),
  bulkUpdateTournamentMatches: (payload) => Cloud.bulkUpdateTournamentMatches(payload.patches),
  bulkCreateTeamMatchups: (payload) => Cloud.bulkCreateTeamMatchups(payload.rows),
  deleteTeamMatchupsBulk: (payload) => Cloud.deleteTeamMatchupsBulk(payload.ids),
  updateTeamMatchup: (payload) => Cloud.updateTeamMatchup(payload.id, payload.patch),
  // Cheap backoff check before calling out, so Outbox.drain()'s frequent piggybacked polling
  // doesn't hammer the Edge Function/DUPR every cycle — the durable retry schedule lives in
  // dupr_match_submissions.next_retry_at, written by the Edge Function itself.
  submitDuprMatch: async (payload) => {
    const statuses = await Dupr.fetchSubmissionStatuses([payload.matchId]);
    const current = statuses[payload.matchId];
    if (current?.nextRetryAt && new Date(current.nextRetryAt) > new Date()) return false;
    const res = await Dupr.submitMatch(payload.matchId);
    // Dequeue on any definitive terminal outcome (submitted / skipped / non-retryable
    // failure) — the durable truth now lives in dupr_match_submissions. Only re-queue when
    // the Edge Function call itself was unreachable or explicitly flagged retryable.
    return res?.ok === true || res?.retryable !== true;
  },
};
Outbox.registerHandlers(OUTBOX_HANDLERS);
