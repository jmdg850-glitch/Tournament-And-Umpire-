export function fmtDate(iso, empty = "—") {
  if (!iso) return empty;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? empty : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// One label per license, in the seller's words.
export function statusOf(l) {
  if (l.status === "revoked") return { key: "revoked", label: "Revoked" };
  if (l.expired) return { key: "expired", label: "Expired" };
  if (l.status === "active") return { key: "active", label: "Activated" };
  return { key: "unused", label: "Not activated" };
}

// Status filter for the license list: exactly the statuses statusOf() produces.
export const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Activated" },
  { key: "unused", label: "Not activated" },
  { key: "expired", label: "Expired" },
  { key: "revoked", label: "Revoked" },
];

export function filterByStatus(items, key) {
  return key === "all" ? items : items.filter((l) => statusOf(l).key === key);
}

// License plans. The server validates the plan and computes every expiry.
export const PLAN_OPTIONS = [
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
  { value: "trial_30", label: "30-Day Trial" },
];
const PLAN_LABELS = { monthly: "Monthly", yearly: "Yearly", trial_30: "30-Day Trial", legacy: "Legacy – no plan" };
export const planLabel = (plan) => PLAN_LABELS[plan] || PLAN_LABELS.legacy;

// Preview only (renew dialog): mirrors addPlanPeriod in
// supabase/functions/license/license.js. The server's result is what is saved.
export function previewRenewal(license, now = Date.now()) {
  const months = { monthly: 1, yearly: 12 }[license.plan];
  if (!months) return null;
  const current = license.expires_at ? Date.parse(license.expires_at) : now;
  const d = new Date(Math.max(now, Number.isFinite(current) ? current : now));
  const month = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(d.getUTCFullYear(), month, Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())).toISOString();
}

// Allowed devices per license. The server validates the same range.
export const DEVICE_LIMIT_MIN = 1;
export const DEVICE_LIMIT_MAX = 100;
export const DEVICE_LIMIT_HINT = `Allowed devices must be a whole number from ${DEVICE_LIMIT_MIN} to ${DEVICE_LIMIT_MAX}.`;

// "3" -> 3; anything that is not a whole number 1..100 -> null.
export function parseDeviceLimit(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n >= DEVICE_LIMIT_MIN && n <= DEVICE_LIMIT_MAX ? n : null;
}

// End of the chosen local day, as an ISO instant (or undefined for "no expiry").
export function endOfDayIso(dateStr) {
  if (!dateStr) return undefined;
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59).toISOString();
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
