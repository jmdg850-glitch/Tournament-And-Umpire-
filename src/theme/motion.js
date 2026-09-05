// Shared framer-motion variants — numeric equivalents of the CSS motion
// tokens in tokens.css (--t-fast/base/slow, --ease). Reused across every
// list/card entrance so a full-app pass doesn't turn into one-off timings
// per screen (see src/theme/tokens.css header for the source values).
export const EASE = [0.2, 0, 0, 1];

// Overlay enter/exit durations (seconds) — previously redeclared locally and
// identically in Modal.jsx/Panel.jsx/OverlayShell.jsx; centralized here so
// every overlay's motion feel moves together. Values unchanged from those
// call sites, so this is a zero-visible-behavior refactor.
export const OVERLAY_DURATION = { modal: 0.2, panel: 0.24, sheet: 0.2 };

export const listVariants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.04 },
  },
};

export const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE } },
};
