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

export function parsePairingInput(raw) {
  return parsePairingPayload(raw);
}
