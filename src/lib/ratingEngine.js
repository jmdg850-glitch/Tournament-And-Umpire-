// RATING ENGINE v2 — original, DUPR-INSPIRED (NOT the official DUPR algorithm) modular rating
// engine. Registered accounts and guest/manual/imported roster rows are both plain entries in
// the same `players[]` array and flow through the exact same `endMatch()` call site, so
// they always share this one engine — there is intentionally no separate code path for either.
//
// Design: an internal, swappable `strategy` object holds every tunable (base rating, K-factor
// curve, expected-score model, confidence curve). `RatingEngine.setStrategy(...)` lets a future
// algorithm (ELO, Glicko, an official DUPR sync, club/tournament multipliers — none implemented
// yet, this is only the seam) replace the strategy without any consuming screen, MatchSetup,
// Categories, Teams, Standings, or History code ever changing.
export const DefaultRatingStrategy = {
  BASE: 3.000,
  // K-factor: how far a single match can move a rating. Scales with confidence — low-confidence
  // (new) players swing up to ~1.5x faster so their rating finds its true level quickly;
  // high-confidence (veteran) players swing down to ~0.4x so an established rating stays stable.
  kFactor(confidence, type) {
    const base = type === "singles" ? 0.12 : 0.10;
    const typeAdj = type === "singles" ? 1.0 : 0.85;
    const c = Math.max(0, Math.min(100, +confidence || 0));
    const confidenceScale = 1.5 - (c / 100) * 1.1; // 1.5x at 0% confidence -> 0.4x at 100%
    return base * typeAdj * confidenceScale;
  },
  // Standard logistic expected-score curve (same shape used by ELO-family engines).
  expectedScore(ratingA, ratingB) {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 4));
  },
  // Original confidence curve (explicitly NOT DUPR's real formula): fast early growth that
  // flattens out, capped under 100% since a rating is never "fully" certain.
  confidenceFor(matchesPlayed) {
    const n = Math.max(0, +matchesPlayed || 0);
    return Math.round(Math.min(99, 100 * (1 - Math.exp(-n / 12))));
  },
};

export const RatingEngine = {
  strategy: DefaultRatingStrategy,
  // Swap in a different rating algorithm later without touching any caller.
  setStrategy(s){ this.strategy = {...DefaultRatingStrategy, ...s}; },
  // `RatingEngine.BASE` stays readable/writable exactly like before (a plain number), but now
  // delegates to the active strategy so the Admin-configured starting rating (see AdminPanel's
  // "Ratings" tab) takes effect everywhere new players are seeded, with zero call-site changes.
  get BASE(){ return this.strategy.BASE; },
  set BASE(v){ this.strategy.BASE = +v || 3.000; },
  K_WIN: 0.040, // retained for backward compatibility; unused by compute() since v2
  K_LOSS: 0.025,

  // Calculate post-match ratings for both sides. `confidenceA`/`confidenceB` are optional
  // (default 0 = fastest movement) so any future caller passing the old 4-field shape still
  // works — endMatch() is the one real caller and always supplies both.
  compute({ ratingA, ratingB, scoreA, scoreB, type, confidenceA = 0, confidenceB = 0 }) {
    const diff = scoreA - scoreB;
    const dominant = Math.abs(diff) / Math.max(scoreA, scoreB, 1);
    const expected = this.strategy.expectedScore(ratingA, ratingB);
    const actualA = scoreA > scoreB ? 1 : 0;
    const kA = this.strategy.kFactor(confidenceA, type);
    const kB = this.strategy.kFactor(confidenceB, type);

    const deltaA = +(kA * (actualA - expected) * (1 + dominant * 0.5)).toFixed(4);
    const deltaB = +(kB * ((1 - actualA) - (1 - expected)) * (1 + dominant * 0.5)).toFixed(4);

    return {
      newA: Math.max(2.0, Math.min(8.0, +(ratingA + deltaA).toFixed(3))),
      newB: Math.max(2.0, Math.min(8.0, +(ratingB + deltaB).toFixed(3))),
      deltaA, deltaB,
    };
  },

  // Compute team average rating for doubles — UNCHANGED signature/behavior.
  teamRating(players, ids) {
    const ratings = ids.map(id => players.find(p=>p.id===id)?.[`rating`] || this.BASE);
    return ratings.reduce((a,b)=>a+b,0)/ratings.length;
  },
  // Compute team average CONFIDENCE for doubles — mirrors teamRating exactly.
  teamConfidence(players, ids) {
    const confs = ids.map(id => {
      const p = players.find(x=>x.id===id);
      return this.confidenceFor((p?.wins||0)+(p?.losses||0));
    });
    return confs.reduce((a,b)=>a+b,0)/confs.length;
  },
  confidenceFor(matchesPlayed){ return this.strategy.confidenceFor(matchesPlayed); },

  format(r) { return (+r||this.BASE).toFixed(3); },
};
