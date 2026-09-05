// Design tokens — "premium scoreboard" identity (warm paper neutrals, near-
// black ink, court-green accent). Values are `var(--x)` references into
// tokens.css so every call site responds live to the [data-theme] attribute
// (see useTheme.js) with zero React re-render — the browser re-resolves the
// CSS variable at paint time. Because these are no longer literal hex,
// alpha-blend call sites must use the `alpha()` helper below instead of
// string concatenation (e.g. `D.accent+"22"` -> `alpha(D.accent, 13)`).
const D = {
  // Core backgrounds — warm paper, not cool gray
  bg:       "var(--bg)",
  surface:  "var(--surface)",
  card:     "var(--surface)",
  cardEl:   "var(--surface-2)",
  cardHi:   "var(--surface-hover)",
  border:   "var(--border)",
  borderHi: "var(--border-strong)",
  // Brand accent — court green
  accent:   "var(--accent)",
  accentHi: "var(--accent-hover)",
  accentBg: "var(--accent-soft)",
  // Secondary blue
  blue:     "var(--blue)",
  blueBg:   "var(--blue-soft)",
  // Status
  green:    "var(--success)",
  greenBg:  "var(--success-soft)",
  amber:    "var(--warn)",
  amberBg:  "var(--warn-soft)",
  red:      "var(--danger)",
  redBg:    "var(--danger-soft)",
  live:     "var(--live)",
  purple:   "#8567F0",
  purpleBg: "#F3F0FE",
  orange:   "#E8690C",
  // Text
  textPrimary:   "var(--ink)",
  textSecondary: "var(--ink-2)",
  textMuted:     "var(--ink-3)",
  textLight:     "var(--border-strong)",
  // Nav
  navBg:    "var(--surface)",
  navBorder:"var(--border)",
  // Dark surfaces for scoring (intentional — ScoringScreen/LiveBoard keep dark chrome,
  // ALWAYS dark regardless of the app-wide light/dark theme toggle — literal hex on
  // purpose, do not convert to var(--x)).
  dark:     "#101113",
  darkCard: "#1B1C1F",
  darkBorder:     "rgba(255,255,255,.08)",
  darkDisabled:   "#334155",
  darkText:       "#F8FAFC",
  darkTextMuted:  "#94A3B8",
  darkTextSubtle: "#64748B",
  darkTextFaint:  "#475569",
  darkAmber: "#E0A339",
  darkRed:   "#E5696E",
  darkGreen: "#33C285",
  // Teams
  teamA:    "#4E8DF7",
  teamB:    "#3FBF7F",
  // Aliases (used across the app; keep in sync with the light theme)
  white:    "var(--ink)", // primary text on light surfaces (legacy name)
  muted:    "var(--ink-3)", // == textMuted
  off:      "var(--ink-2)", // == textSecondary
  focus:    "var(--accent)", // focus ring == accent
  teal:     "var(--accent)", // == accent
};

// Alpha-blend a CSS var reference without breaking in dark mode (string
// concatenation like `D.accent+"22"` doesn't work once D.accent is a
// var(--x) reference — you can't append a hex suffix to a var() call).
export const alpha = (varRef, pct) => `color-mix(in srgb, ${varRef} ${pct}%, transparent)`;

// Deterministic decorative rotation for club cover art — previously an
// identical literal-hex array copy-pasted into ClubsScreen.jsx (x2) and
// ClubDash.jsx, so a palette change had to be made in three places, and none
// of the three responded to the dark/light theme toggle. Same idea as
// LeaderboardScreen's local `COLS` avatar-rotation array, just centralized
// since this one had already drifted into copies. Callers must combine
// entries with `alpha()` for any tint/gradient blending, never a
// string-concatenated hex suffix (these are `var(--x)` references, not
// literal hex — see the file-header comment).
export const CLUB_COVER_COLORS = [D.accent, D.blue, D.purple, D.amber, D.red, D.green];

export { D };
export default D;
