// Pure status→tone mapping behind StatusBadge (components.jsx) — kept separate
// so it's cheap to test without rendering anything.
export function matchStatusTone(status) {
  if (status === "in_progress") return "live";
  if (status === "completed" || status === "bye") return "ok";
  if (status === "cancelled" || status === "abandoned") return "danger";
  if (status === "postponed") return "warn";
  if (status === "ready" || status === "assigned") return "info";
  return "muted";
}

export function tournamentStatusTone(status) {
  if (status === "completed") return "ok";
  if (status === "in_progress" || status === "ready") return "warn";
  return "muted";
}
