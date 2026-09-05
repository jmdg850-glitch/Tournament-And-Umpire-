// OUTBOX — durable write queue for match-completion Cloud writes. endMatch() enqueues each
// Cloud.* write here BEFORE attempting it, so a crash/reload/network drop right after a match
// ends still has every pending write recorded in localStorage; the next drain() (on boot, and
// piggybacked on the existing periodic sync poll) retries anything that didn't confirm success.
// Cloud.upsertMatch/upsertMixPlayer/recordRatingHistory/deleteLiveMatch all return true/false
// so drain() knows whether to remove or retry an item.
//
// Handlers are registered from outboxHandlers.js (after Cloud is constructed) via
// registerHandlers() — this breaks the Cloud <-> Outbox circular reference that existed when
// both lived in one file.
import { LS } from "./storage.js";
import { uid } from "./utils.js";

let handlers = {};

export const Outbox = {
  KEY: "pl6_outbox",
  MAX: 300,
  registerHandlers(map){ handlers = map || {}; },
  read(){ return LS.get(this.KEY, []); },
  write(items){ LS.set(this.KEY, items.slice(-this.MAX)); },
  enqueue(kind, payload){
    const item = { id: kind+"_"+uid(), kind, payload, attempts:0, createdAt: Date.now() };
    this.write([...this.read(), item]);
    return item;
  },
  remove(id){ this.write(this.read().filter(i=>i.id!==id)); },
  bump(id){ this.write(this.read().map(i=>i.id===id?{...i,attempts:i.attempts+1,lastTry:Date.now()}:i)); },
  _draining: false,
  _rerun: false,
  // Retries every queued item once. Serialized — drain() has ~15 call sites across the app
  // with no coordination between them, so two calls landing close together used to both read
  // the same localStorage snapshot and both attempt the same item's network write concurrently.
  // For an insert-only (non-upsert) handler like createDivision, the loser of that race gets a
  // duplicate-key 409, gets bumped (not removed), and then retries — and 409s — forever, since
  // the row already exists. Collapsing concurrent calls into one in-flight pass (plus one
  // guaranteed follow-up if something else enqueued mid-drain) removes the race at the root
  // instead of requiring every handler to be independently idempotent.
  async drain(){
    if(this._draining){ this._rerun = true; return; }
    this._draining = true;
    try{
      do{
        this._rerun = false;
        const items = this.read();
        for(const item of items){
          const fn = handlers[item.kind];
          if(!fn){ this.remove(item.id); continue; }
          let ok;
          try { ok = await fn(item.payload); } catch { ok = false; }
          if(ok) this.remove(item.id); else this.bump(item.id);
        }
      } while(this._rerun);
    } finally {
      this._draining = false;
    }
  },
};
