import { D, alpha } from "../../theme/tokens.js";

// =
// FILTER CHIP — single reusable pill for filter/segmented controls.
// One consistent look everywhere (Home, Standings, Results/Match History, New
// Match wizard) instead of each screen hand-rolling its own selected style —
// previously a mix of solid-fill and tinted-outline treatments that all
// looked slightly different. Standardized on the tinted-outline treatment
// (border + pale tint + colored text when selected) since it was already the
// majority pattern and reads lighter across screens with multiple chip rows
// stacked together (Standings, Match History). `color` accepts a D.* hex and
// derives its own soft/border tints, so callers don't need a matching *Bg
// token for every color they pass.
// =
export function FilterChip({ label, active, onClick, color = D.accent, disabled = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="press"
      style={{
        padding: "9px 16px",
        borderRadius: "var(--r-full)",
        border: "1.5px solid " + (active ? color : D.border),
        background: active ? alpha(color, 9) : D.surface,
        color: active ? color : D.textSecondary,
        fontWeight: 700,
        fontSize: 12.5,
        cursor: disabled ? "default" : "pointer",
        whiteSpace: "nowrap",
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        transition: "background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease)",
      }}
    >
      {label}
    </button>
  );
}

// Convenience wrapper for the common case: an array of {label,value} options,
// single-select, rendered as a horizontally-scrollable row of FilterChips.
// An option may set its own `color` (e.g. status chips where each option has
// a distinct semantic color) to override the group's default `color`.
// `multi` (default false) switches to multi-select: `value` becomes an array
// and `onChange` receives the whole updated array on every toggle, instead of
// a single value — every existing single-select caller is unaffected since
// `multi` defaults false and their `value`/`onChange` shapes are untouched.
export function FilterChipGroup({ options, value, onChange, color = D.accent, style = {}, multi = false }) {
  const isActive = opt => multi ? (Array.isArray(value) && value.includes(opt.value)) : value === opt.value;
  const handleClick = opt => {
    if (!multi) { onChange(opt.value); return; }
    const arr = Array.isArray(value) ? value : [];
    onChange(arr.includes(opt.value) ? arr.filter(v => v !== opt.value) : [...arr, opt.value]);
  };
  return (
    <div style={{ display: "flex", gap: 8, overflowX: "auto", scrollbarWidth: "none", ...style }}>
      {options.map((opt) => (
        <FilterChip
          key={opt.value}
          label={opt.label}
          active={isActive(opt)}
          onClick={() => handleClick(opt)}
          color={opt.color || color}
        />
      ))}
    </div>
  );
}
