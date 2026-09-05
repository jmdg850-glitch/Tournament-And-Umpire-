// Shared by ScoreboardApp.jsx (outer wrapper) and ScoreboardDisplay.jsx, so there's one
// source of truth for the scoreboard's two color schemes. `dark` reproduces the original
// hardcoded values exactly (zero visual regression); `light` is new. Split into its own
// file (not exported alongside a component) so React Fast Refresh keeps working.
export const SCOREBOARD_PALETTES = {
  dark:  { bg:"#000",    text:"#fff", textMuted:"rgba(255,255,255,.65)", textFaint:"rgba(255,255,255,.55)", chipBg:"rgba(255,255,255,.1)", pip:"rgba(255,255,255,.35)" },
  light: { bg:"#F4F4F2", text:"#14161A", textMuted:"rgba(20,22,26,.6)", textFaint:"rgba(20,22,26,.5)", chipBg:"rgba(20,22,26,.08)", pip:"rgba(20,22,26,.3)" },
};
