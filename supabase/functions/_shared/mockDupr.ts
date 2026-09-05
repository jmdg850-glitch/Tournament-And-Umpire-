// Same interface as duprClient.ts, canned responses. Gated by
// DUPR_MOCK_MODE=true (the default until real DUPR credentials exist — see
// plan doc). This is what makes the whole submit-match / link-dupr-account
// flow — auth, authorization, idempotent claim, retry/backoff, error
// surfaces — testable end-to-end today without any real DUPR access.
import type { DuprCallResult, DuprMatchCreateResult, ExternalMatchRequest } from "./types.ts";

let callCount = 0;

// Deterministic-ish: every 4th createMatch call simulates a retryable
// failure, so the retry/backoff path gets exercised without being flaky for
// every other test run.
export const mockDuprClient = {
  async createMatch(payload: ExternalMatchRequest): Promise<DuprCallResult<DuprMatchCreateResult>> {
    callCount++;
    await new Promise((r) => setTimeout(r, 150)); // simulate network latency

    if (callCount % 4 === 0) {
      return { ok: false, retryable: true, error: "[mock] simulated transient failure", httpStatus: 503 };
    }
    if (!payload.teamA?.player1 || !payload.teamB?.player1) {
      return { ok: false, retryable: false, error: "[mock] missing required player field", httpStatus: 400 };
    }

    const matchCode = `MOCK-${payload.identifier.slice(0, 8)}-${Date.now().toString(36)}`;
    return {
      ok: true,
      retryable: false,
      data: {
        identifier: payload.identifier,
        matchCode,
        hashedMatchCode: btoa(matchCode).slice(0, 10),
      },
    };
  },

  async searchPlayersByName(
    query: string,
    limit = 10,
  ): Promise<DuprCallResult<{ hits: Array<{ duprId: string; fullName: string; singlesRating?: number; doublesRating?: number }>; total: number }>> {
    await new Promise((r) => setTimeout(r, 100));
    // Deterministic fake id from the query so repeated searches in a demo are stable.
    const fakeId = `MOCK${Math.abs(hashCode(query)).toString().slice(0, 7)}`;
    const hits = query.trim()
      ? [{ duprId: fakeId, fullName: `Mock ${query.trim()}`, singlesRating: 3.5, doublesRating: 3.8 }].slice(0, limit)
      : [];
    return { ok: true, retryable: false, data: { hits, total: hits.length } };
  },

  async getUserDetails(
    duprId: string,
  ): Promise<DuprCallResult<{ fullName?: string; duprId?: string; singlesRating?: number; doublesRating?: number }>> {
    await new Promise((r) => setTimeout(r, 100));
    if (!duprId.startsWith("MOCK")) {
      return { ok: false, retryable: false, error: "[mock] unknown DUPR id", httpStatus: 404 };
    }
    return { ok: true, retryable: false, data: { duprId, fullName: "Mock DUPR Player", singlesRating: 3.5, doublesRating: 3.8 } };
  },

  async registerWebhook(): Promise<DuprCallResult<unknown>> {
    return { ok: true, retryable: false, data: { registered: true } };
  },

  async viewMatch(matchCode: number): Promise<DuprCallResult<Record<string, unknown>>> {
    await new Promise((r) => setTimeout(r, 100));
    return {
      ok: true,
      retryable: false,
      data: { id: matchCode, matchId: matchCode, status: "COMPLETE", eloCalculated: true, teams: [] },
    };
  },
};

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
