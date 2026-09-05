// Typed fetch wrapper over the documented DUPR Partner API contract
// (https://uat.mydupr.com/api/v3/api-docs). Every call normalizes DUPR's
// {status:"SUCCESS"|"FAILURE", result|message} envelope into one
// {ok, retryable, data|error} shape so callers never touch the raw envelope.
// Self-throttled to ~1 req/sec from day one as a conservative default —
// DUPR's actual rate limits weren't found in available research; tune once
// real UAT usage shows observed limits (see plan doc).
import { getDuprBearerToken } from "./duprAuth.ts";
import { mockDuprClient } from "./mockDupr.ts";
import type { DuprCallResult, DuprMatchCreateResult, ExternalMatchRequest } from "./types.ts";

const MIN_INTERVAL_MS = 1000;
let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function config() {
  return {
    baseUrl: Deno.env.get("DUPR_BASE_URL") || "https://uat.mydupr.com/api",
    // Confirmed against the live spec: default version segment is "v1.0".
    version: Deno.env.get("DUPR_VERSION") || "v1.0",
  };
}

async function call<T>(path: string, init: RequestInit): Promise<DuprCallResult<T>> {
  await throttle();
  const token = await getDuprBearerToken();
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
  } catch (err) {
    // Network-level failure — always retryable.
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : "network error" };
  }

  // Captured on every response (success or failure) — DUPR support wants this
  // when investigating a reported issue; logged here so it's always visible
  // in Edge Function logs even for a call whose result never gets persisted.
  const requestId = res.headers.get("X-Request-Id") || undefined;
  if (requestId) console.log(`[dupr] ${path} — X-Request-Id: ${requestId}`);

  if (res.status === 429) {
    return { ok: false, retryable: true, error: "Rate limited by DUPR (429)", httpStatus: 429, requestId };
  }
  if (res.status >= 500) {
    return { ok: false, retryable: true, error: `DUPR server error (${res.status})`, httpStatus: res.status, requestId };
  }

  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status === "FAILURE") {
    // 4xx validation errors are not retryable — the same payload will fail again.
    return {
      ok: false,
      retryable: false,
      error: body?.message || `DUPR request failed (${res.status})`,
      httpStatus: res.status,
      requestId,
    };
  }

  return { ok: true, retryable: false, data: (body?.result ?? body) as T, requestId };
}

export const duprClient = {
  async createMatch(payload: ExternalMatchRequest): Promise<DuprCallResult<DuprMatchCreateResult>> {
    const { baseUrl, version } = config();
    return call<DuprMatchCreateResult>(`${baseUrl}/match/${version}/create`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  // Confirmed against the live spec: there is no email-lookup endpoint at
  // all in the real DUPR Partner API (the previous implementation called
  // POST /{version}/player/duprid-by-email, which does not exist anywhere
  // in the spec's 33 paths). The only real player-lookup mechanism is
  // full-text name search — POST /user/{version}/search — used here for the
  // organizer-assisted "link a guest player" flow (self-linking uses the
  // real iframe SSO flow instead, which returns the duprId directly).
  async searchPlayersByName(
    query: string,
    limit = 10,
  ): Promise<DuprCallResult<{ hits: Array<{ duprId: string; fullName: string; singlesRating?: number; doublesRating?: number }>; total: number }>> {
    const { baseUrl, version } = config();
    return call(`${baseUrl}/user/${version}/search`, {
      method: "POST",
      body: JSON.stringify({ query, offset: 0, limit }),
    });
  },

  // GET /user/{version}/{id} ("User Info", needs only USER::DETAIL — every
  // partner has this). NOT /user/{version}/{id}/details ("Extended User
  // Info") — the spec documents that variant as requiring an additional
  // USER_EMAIL::VIEW grant and returning 403 for most partners, which is
  // exactly the "required permissions" error real UAT testing hit here.
  // singlesRating/doublesRating: same fields already typed on
  // searchPlayersByName's response above — this is the same "User Info"
  // response shape, just typed narrowly until now.
  async getUserDetails(
    duprId: string,
  ): Promise<DuprCallResult<{ fullName?: string; duprId?: string; singlesRating?: number; doublesRating?: number }>> {
    const { baseUrl, version } = config();
    return call(`${baseUrl}/user/${version}/${encodeURIComponent(duprId)}`, { method: "GET" });
  },

  async registerWebhook(webhookUrl: string, topics: string[]): Promise<DuprCallResult<unknown>> {
    const { baseUrl, version } = config();
    return call(`${baseUrl}/${version}/webhook`, {
      method: "POST",
      body: JSON.stringify({ webhookUrl, topics }),
    });
  },

  // GET /match/{version}/{id} ("View Match", needs MATCH::VIEW). {id} is the
  // numeric matchCode returned by createMatch — NOT the hashedMatchCode or
  // our own identifier. Read-only; used to independently verify a submitted
  // match against DUPR's own record (players, scores, event/club, rating
  // impact) rather than trusting only what we stored locally.
  async viewMatch(matchCode: number): Promise<DuprCallResult<Record<string, unknown>>> {
    const { baseUrl, version } = config();
    return call(`${baseUrl}/match/${version}/${matchCode}`, { method: "GET" });
  },
};

// Single switch point for mock vs. real DUPR — every handler calls
// getDupr() rather than importing duprClient/mockDuprClient directly, so
// flipping DUPR_MOCK_MODE never requires touching handler code.
export function getDupr(): typeof duprClient {
  const mock = (Deno.env.get("DUPR_MOCK_MODE") || "true").toLowerCase() === "true";
  return mock ? mockDuprClient : duprClient;
}
