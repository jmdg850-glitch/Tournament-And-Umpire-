// packages/api/src/writes.js
function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// packages/api/src/stationAuth.js
function b64url(bytes) {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function b64urlToBytes(s) {
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/") + pad;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function envGet(name) {
  if (typeof process !== "undefined" && process.env?.[name]) return process.env[name];
  const deno = globalThis.Deno;
  if (deno?.env?.get) return deno.env.get(name) || "";
  return "";
}
function stationJwtSecret() {
  return envGet("STATION_JWT_SECRET");
}
async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}
async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}
async function signStationJwt({ deviceId, courtId, tournamentId, ttlSec = 3600 }, secret = stationJwtSecret()) {
  if (!secret) throw httpError(500, "MISCONFIGURED", "STATION_JWT_SECRET is not set");
  const now = Math.floor(Date.now() / 1e3);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    typ: "station",
    sub: deviceId,
    court_id: courtId,
    tournament_id: tournamentId,
    iat: now,
    exp: now + ttlSec
  }));
  const sig = await hmacSign(secret, `${header}.${payload}`);
  return `${header}.${payload}.${sig}`;
}
async function verifyStationJwt(token, secret = stationJwtSecret()) {
  if (!secret || !token || token.split(".").length !== 3) return null;
  const [header, payload, sig] = token.split(".");
  const expected = await hmacSign(secret, `${header}.${payload}`);
  if (expected.length !== sig.length) return null;
  let same = 0;
  for (let i = 0; i < expected.length; i++) same |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (same !== 0) return null;
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
  } catch {
    return null;
  }
  if (body.typ !== "station" || !body.sub || !body.court_id || !body.tournament_id) return null;
  const now = Math.floor(Date.now() / 1e3);
  if (body.exp && now > body.exp) return null;
  return body;
}
async function resolveActor(admin, jwt) {
  if (!jwt) throw httpError(401, "UNAUTHENTICATED", "Missing JWT");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (user) return { kind: "user", id: user.id, email: user.email };
  const claims = await verifyStationJwt(jwt);
  if (!claims) throw httpError(401, "UNAUTHENTICATED", "Invalid JWT");
  const { data: device, error } = await admin.from("court_devices").select("*").eq("id", claims.sub).maybeSingle();
  if (error) throw error;
  if (!device || device.status !== "active") throw httpError(401, "UNAUTHENTICATED", "Device is not active");
  if (device.court_id !== claims.court_id || device.tournament_id !== claims.tournament_id) {
    throw httpError(401, "UNAUTHENTICATED", "Device token mismatch");
  }
  return {
    kind: "station",
    id: device.id,
    deviceId: device.id,
    courtId: device.court_id,
    tournamentId: device.tournament_id
  };
}
async function handlePairStation({ admin, body }) {
  const action = body?.action || "pair";
  if (action === "refresh") return refreshStation(admin, body);
  if (action !== "pair") throw httpError(400, "INVALID_COMMAND", "action must be pair or refresh");
  const pairingToken = String(body?.pairing_token || "").trim();
  if (!pairingToken) throw httpError(400, "INVALID_COMMAND", "pairing_token is required");
  const tokenHash = await sha256Hex(pairingToken);
  const { data: grant, error } = await admin.from("court_pairing_grants").select("*").eq("token_hash", tokenHash).maybeSingle();
  if (error) throw error;
  if (!grant) throw httpError(401, "INVALID_GRANT", "Unknown pairing token");
  if (grant.consumed_at) throw httpError(409, "GRANT_USED", "Pairing token already used");
  if (new Date(grant.expires_at).getTime() < Date.now()) throw httpError(401, "GRANT_EXPIRED", "Pairing window expired");
  if (body.station_public_id) {
    const { data: court2 } = await admin.from("courts").select("id, station_public_id").eq("id", grant.court_id).maybeSingle();
    if (!court2 || court2.station_public_id !== String(body.station_public_id).trim()) {
      throw httpError(400, "COURT_MISMATCH", "QR does not match this pairing grant");
    }
  }
  const { data: active } = await admin.from("court_devices").select("id").eq("court_id", grant.court_id).eq("status", "active").maybeSingle();
  if (active) throw httpError(409, "DEVICE_ACTIVE", "Revoke the current device before pairing a replacement");
  const deviceId = crypto.randomUUID();
  const refreshToken = randomToken();
  const refreshHash = await sha256Hex(refreshToken);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const { error: insErr } = await admin.from("court_devices").insert({
    id: deviceId,
    court_id: grant.court_id,
    tournament_id: grant.tournament_id,
    refresh_token_hash: refreshHash,
    status: "active",
    device_label: String(body.device_label || "").slice(0, 80),
    paired_at: now,
    created_at: now
  });
  if (insErr) throw insErr;
  const { error: consumeErr } = await admin.from("court_pairing_grants").update({ consumed_at: now }).eq("id", grant.id).is("consumed_at", null);
  if (consumeErr) throw consumeErr;
  const accessToken = await signStationJwt({
    deviceId,
    courtId: grant.court_id,
    tournamentId: grant.tournament_id
  });
  const { data: court } = await admin.from("courts").select("*").eq("id", grant.court_id).maybeSingle();
  return {
    ok: true,
    result: {
      access_token: accessToken,
      refresh_token: refreshToken,
      device_id: deviceId,
      court,
      tournament_id: grant.tournament_id
    }
  };
}
async function refreshStation(admin, body) {
  const refreshToken = String(body?.refresh_token || "").trim();
  if (!refreshToken) throw httpError(400, "INVALID_COMMAND", "refresh_token is required");
  const refreshHash = await sha256Hex(refreshToken);
  const { data: device, error } = await admin.from("court_devices").select("*").eq("refresh_token_hash", refreshHash).maybeSingle();
  if (error) throw error;
  if (!device || device.status !== "active") throw httpError(401, "UNAUTHENTICATED", "Device is not active");
  const accessToken = await signStationJwt({
    deviceId: device.id,
    courtId: device.court_id,
    tournamentId: device.tournament_id
  });
  await admin.from("court_devices").update({ last_seen_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", device.id);
  const { data: court } = await admin.from("courts").select("*").eq("id", device.court_id).maybeSingle();
  return {
    ok: true,
    result: {
      access_token: accessToken,
      device_id: device.id,
      court,
      tournament_id: device.tournament_id
    }
  };
}
export {
  envGet,
  handlePairStation,
  hmacSign,
  randomToken,
  resolveActor,
  sha256Hex,
  signStationJwt,
  stationJwtSecret,
  verifyStationJwt
};
