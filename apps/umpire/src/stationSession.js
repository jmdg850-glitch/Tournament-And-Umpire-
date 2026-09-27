import { parsePairingPayload } from "@tournament/contracts";

const KEY = "tournament.courtStation";

export function readStation() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeStation(value) {
  localStorage.setItem(KEY, JSON.stringify(value));
}

export function clearStation() {
  localStorage.removeItem(KEY);
}

// Reads (does NOT verify — the server does that) the claims of the station
// JWT; used only for the local expiry check and the local owner identity.
export function stationClaims(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// The identity queued commands are tied to: this exact court pairing.
export function stationDeviceId(station) {
  return station?.device_id || stationClaims(station?.access_token)?.sub || null;
}

export function stationTokenExpiresSoon(token, marginSec = 120, nowMs = Date.now()) {
  const exp = Number(stationClaims(token)?.exp);
  if (!Number.isFinite(exp)) return false;
  return exp * 1000 - nowMs < marginSec * 1000;
}

export function parsePairingInput(raw) {
  return parsePairingPayload(raw);
}
