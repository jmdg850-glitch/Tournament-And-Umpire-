import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { matchStatusTone, tournamentStatusTone } from "./statusTone.js";
import logoColor from "./brand/resetiq-logo-color.png";
import logoWhite from "./brand/resetiq-logo-white.png";
import stackedWhite from "./brand/resetiq-stacked-white.png";
import symbolWhite from "./brand/resetiq-symbol-white.png";

// RESETIQ artwork, cut from the official brand sheet at native resolution.
// width/height are the files' intrinsic pixel sizes so the browser reserves
// the right aspect ratio before the image loads (no layout shift); CSS sets
// the rendered height. White variants are for dark backgrounds only.
const BRAND_ART = {
  "horizontal/color": { src: logoColor, width: 1083, height: 245 },
  "horizontal/white": { src: logoWhite, width: 1083, height: 245 },
  "stacked/white": { src: stackedWhite, width: 661, height: 381 },
  "symbol/white": { src: symbolWhite, width: 238, height: 245 },
};

/** The RESETIQ logo. variant: "horizontal" | "stacked" | "symbol"; tone: "color" | "white". */
export function BrandLogo({ variant = "horizontal", tone = "color", className = "", alt = "RESETIQ" }) {
  const art = BRAND_ART[`${variant}/${tone}`] || BRAND_ART["horizontal/color"];
  return (
    <img
      className={`brand-logo ${className}`.trim()}
      src={art.src}
      width={art.width}
      height={art.height}
      alt={alt}
      draggable={false}
      decoding="async"
    />
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  type = "button",
  busy = false,
  disabled,
  ...props
}) {
  const extra = variant === "primary" ? "" : variant;
  // `busy` shows an inline spinner next to the caller's own label ("Signing
  // in…", "Saving…") and blocks further clicks until the work settles.
  return (
    <button
      type={type}
      className={`btn ${extra} ${className}`.trim()}
      disabled={busy || disabled}
      aria-busy={busy ? "true" : undefined}
      data-busy={busy ? "true" : undefined}
      {...props}
    >
      {busy ? <span className="btn-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

// Replays a short "tick" only when the value changes after mount, so a score
// update is noticeable at a glance but a list of scores mounting stays still.
export function TickNumber({ value, className = "" }) {
  const prev = useRef(value);
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setTicks((n) => n + 1);
    }
  }, [value]);
  return (
    <span key={ticks} className={`${ticks ? "tick" : ""} ${className}`.trim() || undefined}>
      {value}
    </span>
  );
}

const REFRESH_ICON = (
  <svg className="refresh-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </svg>
);

/**
 * Refresh control with built-in feedback: the icon spins while a refresh is in
 * flight (its own, or an external `busy` such as an automatic reload), extra
 * clicks are ignored meanwhile, and a brief "Updated" confirms a refresh that
 * completed. `onRefresh` may resolve to `false` to signal a failed refresh —
 * the caller's own error UI handles that case, and no "Updated" is shown.
 * `confirmDone={false}` keeps only the spinner + duplicate-click guard, for
 * callers whose reload can't report success.
 */
export function RefreshButton({ onRefresh, busy = false, label = "Refresh", iconOnly = false, confirmDone = true, className = "", variant = "secondary", disabled, ...props }) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const doneTimer = useRef(0);
  useEffect(() => () => {
    mounted.current = false;
    window.clearTimeout(doneTimer.current);
  }, []);
  const spinning = running || busy;
  async function click() {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    setRunning(true);
    setDone(false);
    let ok = false;
    try {
      ok = (await onRefresh?.()) !== false;
    } catch {
      ok = false;
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setRunning(false);
        if (ok && confirmDone) {
          setDone(true);
          window.clearTimeout(doneTimer.current);
          doneTimer.current = window.setTimeout(() => { if (mounted.current) setDone(false); }, 1500);
        }
      }
    }
  }
  const showDone = done && !spinning;
  return (
    <Button
      variant={variant}
      className={`refresh-btn ${iconOnly ? "icon" : ""} ${className}`.trim()}
      data-spinning={spinning ? "true" : undefined}
      data-done={showDone ? "true" : undefined}
      aria-label={iconOnly || props["aria-label"] ? (props["aria-label"] || label) : undefined}
      title={iconOnly ? (props.title || label) : props.title}
      disabled={disabled}
      aria-busy={spinning ? "true" : undefined}
      onClick={click}
      {...props}
    >
      {showDone ? <span className="refresh-done" aria-hidden="true">✓</span> : REFRESH_ICON}
      {iconOnly ? null : <span className="refresh-label" aria-hidden={showDone ? "true" : undefined}>{showDone ? "Updated" : label}</span>}
      <span className="sr-only" aria-live="polite">{showDone ? "Updated" : ""}</span>
    </Button>
  );
}

const MATCH_STATUS_LABEL = {
  in_progress: "LIVE",
  scheduled: "SCHEDULED",
  ready: "READY",
  assigned: "ASSIGNED",
  completed: "COMPLETED",
  postponed: "POSTPONED",
  cancelled: "CANCELLED",
  abandoned: "ABANDONED",
  bye: "BYE",
};

const TOURNAMENT_STATUS_LABEL = {
  draft: "DRAFT",
  registration: "REGISTRATION",
  registration_closed: "REG CLOSED",
  ready: "READY",
  in_progress: "IN PROGRESS",
  completed: "COMPLETED",
  cancelled: "CANCELLED",
  archived: "ARCHIVED",
};

export function StatusBadge({ status, kind = "match" }) {
  const labels = kind === "tournament" ? TOURNAMENT_STATUS_LABEL : MATCH_STATUS_LABEL;
  const tone = kind === "tournament" ? tournamentStatusTone(status) : matchStatusTone(status);
  const label = labels[status] || String(status || "unknown").replaceAll("_", " ");
  return <Badge tone={tone}>{label}</Badge>;
}

export function ServeIndicator({ state, className = "" }) {
  const server = Number(state?.server);
  if (server !== 1 && server !== 2) return null;
  return (
    <div className={`serve-status ${className}`.trim()} aria-live="polite">
      {server === 1 ? "FIRST SERVE" : "SECOND SERVE"}
    </div>
  );
}

export function Stat({ value, label, tone = "" }) {
  return (
    <div className={`stat ${tone}`.trim()}>
      <div className="n">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function Scoreboard({ nameA, nameB, scoreA = 0, scoreB = 0, center, className = "" }) {
  return (
    <div className={`scoreboard ${className}`.trim()} aria-live="polite">
      <div>
        <div className="who" title={nameA}>{nameA}</div>
        <div className="pts"><TickNumber value={scoreA} /></div>
      </div>
      <div>{center}</div>
      <div>
        <div className="who" title={nameB}>{nameB}</div>
        <div className="pts"><TickNumber value={scoreB} /></div>
      </div>
    </div>
  );
}

// Re-renders the caller on a fixed tick while `active`, and returns a fresh
// Date.now() on every render — so a countdown is recomputed from the clock
// each time (never decremented), can't drift, and one interval exists per
// caller. Also re-renders when the page becomes visible again (after sleep
// or background), where interval ticks may have been throttled.
export function useNow(active, intervalMs = 250) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const bump = () => setTick((n) => (n + 1) % 1_000_000);
    const id = window.setInterval(bump, intervalMs);
    const onVisible = () => { if (document.visibilityState === "visible") bump(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, intervalMs]);
  return Date.now();
}

// Game timer display. Presentational only: the caller passes the computed
// view ({ state, remainingMs, durationSec } from the engine's timerView) and
// the formatted clock. state "none" (or anything unknown) renders nothing.
const GAME_TIMER_LABEL = {
  running: "Time left",
  paused: "Timer paused",
  expired: "Time",
  finished: "Time left at finish",
};

export function GameTimer({ view, clock, className = "" }) {
  const state = view?.state;
  if (state === "configured") {
    const minutes = Math.round((view.durationSec || 0) / 60);
    return (
      <div className={`game-timer ${className}`.trim()} data-state="configured">
        <span className="game-timer-label">Game time</span>{" "}
        <span className="game-timer-clock">{minutes} min</span>
      </div>
    );
  }
  if (!GAME_TIMER_LABEL[state]) return null;
  return (
    <div
      className={`game-timer ${className}`.trim()}
      data-state={state}
      role="timer"
      aria-label={state === "expired" ? "Game time expired" : `${GAME_TIMER_LABEL[state]} ${clock}`}
    >
      <span className="game-timer-label">{GAME_TIMER_LABEL[state]}</span>{" "}
      <span className="game-timer-clock">{state === "expired" ? "00:00" : clock}</span>
    </div>
  );
}

export function Input({ label, id, hint, error, ...props }) {
  const autoId = useId();
  const inputId = id || autoId;
  return (
    <label htmlFor={inputId}>
      {label}
      <input id={inputId} aria-invalid={error ? "true" : undefined} {...props} />
      {hint && !error ? <span className="hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export function Select({ label, id, hideLabel, hint, children, ...props }) {
  const autoId = useId();
  const inputId = id || autoId;
  return (
    <label htmlFor={inputId}>
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
      <select id={inputId} {...props}>
        {children}
      </select>
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

/** Forwards its ref to the underlying <input> — callers rely on this to set the
 * non-prop `.indeterminate` DOM property (e.g. a "select all" header checkbox). */
export const Checkbox = forwardRef(function Checkbox({ className = "", ...props }, ref) {
  return <input ref={ref} type="checkbox" className={`checkbox ${className}`.trim()} {...props} />;
});

export function Badge({ children, tone = "muted" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Card({ as: Tag = "div", children, className = "", ...props }) {
  return (
    <Tag className={`panel ${className}`.trim()} {...props}>
      {children}
    </Tag>
  );
}

export function PageHeader({ kicker, title, actions, children }) {
  return (
    <header className="page-header">
      <div>
        {kicker ? <div className="kicker">{kicker}</div> : null}
        <h1>{title}</h1>
        {children}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  );
}

/** For same-page content tabs (a WAI-ARIA tablist switching what's shown below it) —
 * distinct from NavItem, which is page-to-page navigation and deliberately does not
 * use the tab-widget pattern (see the note on NavGroup). Not yet adopted anywhere;
 * reserved for when a hand-rolled tab-state screen switcher gets componentized. */
/**
 * Per-screen sub-header used inside a page that already has its own top-level
 * PageHeader (e.g. one panel/tab within a larger desk) — renders at h2, not h1,
 * so a screen never ends up with two competing top-level headings. Reuses the
 * existing .panel-toolbar/.panel-toolbar-title/.panel-toolbar-sub/
 * .panel-toolbar-actions classes verbatim (including their responsive
 * action-wrapping at 560px) rather than introducing a second, parallel set.
 */
export function SectionHeader({ title, description, actions }) {
  return (
    <div className="panel-toolbar">
      <div>
        <h2 className="panel-toolbar-title">{title}</h2>
        {description ? <p className="muted panel-toolbar-sub">{description}</p> : null}
      </div>
      {actions ? <div className="panel-toolbar-actions">{actions}</div> : null}
    </div>
  );
}

/** For same-page content tabs (a WAI-ARIA tablist switching what's shown below it) —
 * distinct from NavItem, which is page-to-page navigation and deliberately does not
 * use the tab-widget pattern (see the note on NavGroup). Assessed for adoption in
 * TournamentDesk's screen switcher and declined — that's genuinely page-to-page
 * navigation (NavItem/NavGroup is already correct there), not same-page tabs.
 * Still reserved for a genuine future same-page-tab need (e.g. a status filter
 * within one screen). */
export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="nav-tabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          data-active={value === id}
          className="btn secondary"
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Table({ columns, rows, empty, rowProps, responsive }) {
  if (!rows?.length) return empty || null;
  return (
    <div className="table-wrap" data-responsive-cards={responsive ? "true" : undefined}>
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id || i} {...(rowProps ? rowProps(row) : {})}>
              {columns.map((c) => (
                <td key={c.key} data-label={typeof c.header === "string" ? c.header : undefined}>
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const RANK_MEDAL = { 1: "🥇", 2: "🥈", 3: "🥉" };

/** Leaderboard-style table for standings. `rows` need: rank, name, plus any of team/wins/losses/pointDiff/winPct/extra.
 * `nameHeader` overrides the auto-picked header for the `name` column (e.g. "Team" for a team-level table). */
export function StandingsTable({ rows, extraColumns = [], nameHeader }) {
  if (!rows?.length) return null;
  const hasTeam = rows.some((r) => r.team);
  return (
    <Table
      responsive
      columns={[
        {
          key: "rank",
          header: "Rank",
          render: (r) => (
            <span className="rank-cell">
              {RANK_MEDAL[r.rank] ? <span className="rank-medal" aria-hidden="true">{RANK_MEDAL[r.rank]}</span> : null}
              {r.rank}
            </span>
          ),
        },
        { key: "name", header: nameHeader || (hasTeam ? "Pair / Player" : "Player") },
        ...(hasTeam ? [{ key: "team", header: "Team" }] : []),
        { key: "wins", header: "W" },
        { key: "losses", header: "L" },
        { key: "pointDiff", header: "+/-", render: (r) => (r.pointDiff > 0 ? `+${r.pointDiff}` : r.pointDiff) },
        ...extraColumns,
      ]}
      rows={rows.map((r) => ({ id: r.id ?? r.rank, ...r }))}
      rowProps={(r) => ({ "data-rank": r.rank <= 3 ? String(r.rank) : undefined })}
    />
  );
}

/** An interactive Card — a whole panel that acts as a button (e.g. a tappable match-list item). */
export function ClickableCard({ children, className = "", live, ...props }) {
  return (
    <Card as="button" type="button" className={`card-clickable ${className}`.trim()} data-live={live ? "true" : undefined} {...props}>
      {children}
    </Card>
  );
}

/** "What should I do next" setup progress guide. items: [{ id, label, done, action? }] */
export function SetupChecklist({ items }) {
  const firstPendingIndex = items.findIndex((i) => !i.done);
  return (
    <div className="checklist">
      {items.map((item, i) => (
        <div key={item.id} className="checklist-item" data-done={item.done} data-next={i === firstPendingIndex}>
          <span className="mark" aria-hidden="true">{item.done ? "✓" : ""}</span>
          <span className="label">{item.label}</span>
          {!item.done && item.action ? <span className="go">{item.action}</span> : null}
        </div>
      ))}
    </div>
  );
}

export function Alert({ children, tone = "error" }) {
  const cls = tone === "ok" ? "alert ok" : tone === "warn" ? "alert warn" : "alert";
  return <div role="alert" className={cls}>{children}</div>;
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <div style={{ marginTop: 6 }}>{children}</div> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

export function LoadingState({ label = "Loading" }) {
  return (
    <div className="row" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label}</span>
    </div>
  );
}

/**
 * Branded boot/loading screen, shared by both apps' "restoring session" state
 * (see App.jsx in each app) — not shown on every tab change, only while the
 * app is genuinely still initializing. Purely reactive to how long that
 * actually takes: there is no artificial minimum-display timer here, so a
 * fast start never turns this into a forced wait, and a slow one just leaves
 * it on screen naturally for as long as it takes. `prefers-reduced-motion`
 * is handled by the same global `* { animation: none !important }` rule this
 * stylesheet already applies everywhere else (see the bottom of this file's
 * companion styles.css) — no separate reduced-motion branch is needed here.
 */
export function SplashScreen({ brand, tagline, status, continued = false }) {
  // `continued`: a second boot phase (e.g. the license check right after
  // session restore) keeps the same splash on screen without replaying the
  // entrance, so startup reads as one continuous step.
  return (
    <div className="splash-screen" role="status" aria-live="polite" data-continued={continued ? "true" : undefined}>
      <div className="splash-mark">
        <span className="splash-line" aria-hidden="true" />
        {brand
          ? <h1>{brand}</h1>
          : <h1 className="splash-logo"><BrandLogo variant="stacked" tone="white" /></h1>}
        {tagline ? <div className="splash-tagline">{tagline}</div> : null}
      </div>
      {status ? (
        <div className="splash-status">
          <span className="spinner" aria-hidden="true" />
          <span>{status}</span>
        </div>
      ) : null}
    </div>
  );
}

export function Skeleton({ lines = 3, variant = "lines", count = 3 }) {
  if (variant === "card") {
    return (
      <div className="stack skeleton-cards" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="skeleton skeleton-card">
            <div className="skeleton skeleton-line" style={{ width: "58%" }} />
            <div className="skeleton skeleton-line" style={{ width: "34%" }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="stack" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: i === lines - 1 ? "62%" : "100%" }} />
      ))}
    </div>
  );
}

export function Modal({ title, children, onClose, labelledBy }) {
  const titleId = useId();
  const ref = useRef(null);
  // Callers pass a new inline onClose on every render; keeping it in a ref
  // lets the focus effect run once per open. Re-running it on each keystroke
  // pulled focus back to the first field.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement;
    const node = ref.current?.querySelector("button, input, select, textarea, [tabindex]:not([tabindex='-1'])");
    node?.focus();
    function onKey(e) {
      if (e.key === "Escape") onCloseRef.current?.();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy || titleId}
      >
        {title ? <h2 id={titleId}>{title}</h2> : null}
        <div style={{ marginTop: title ? 12 : 0 }}>{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, body, confirmLabel = "Confirm", danger, busy, onConfirm, onCancel }) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p>{body}</p>
      <div className="row" style={{ marginTop: 16 }}>
        <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={onConfirm}>
          {busy ? "Working…" : confirmLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </Modal>
  );
}

export function Dropdown({ label, children }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  // Standard menu dismissal: Escape or a press outside closes it (an item
  // click still closes it too, as before).
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) { if (e.key === "Escape") setOpen(false); }
    function onDown(e) { if (!rootRef.current?.contains(e.target)) setOpen(false); }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="dropdown" style={{ position: "relative" }}>
      <Button variant="secondary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </Button>
      {open ? (
        <div className="panel dropdown-menu" style={{ position: "absolute", right: 0, top: "110%", zIndex: 20, minWidth: 180 }}>
          <div onClick={() => setOpen(false)}>{children}</div>
        </div>
      ) : null}
    </div>
  );
}

const ToastCtx = createContext(() => {});
const TOAST_MAX = 4;
const TOAST_EXIT_MS = 180;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, tone = "ok") => {
    const id = crypto.randomUUID();
    // Same 4.2s total lifetime as before, split so the last 180ms can play a
    // short exit instead of the toast vanishing. At most 4 stay stacked.
    setToasts((list) => [...list, { id, message, tone }].slice(-TOAST_MAX));
    window.setTimeout(() => setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t))), 4200 - TOAST_EXIT_MS);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`.trim()} data-leaving={t.leaving ? "true" : undefined}>{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/**
 * Shared app shell: a sidebar rail (brand + optional context block + grouped nav + footer)
 * beside a main content area. Replaces per-app hand-rolled shells so both apps share one
 * accessible, consistent layout.
 */
export function PageShell({ brand, context, nav, navLabel = "Sections", foot, children, overlay }) {
  return (
    <div className="shell">
      <aside className="shell-rail">
        {brand ? <div className="shell-brand">{brand}</div> : null}
        {context ? <div className="shell-context">{context}</div> : null}
        <nav className="shell-nav" aria-label={navLabel}>{nav}</nav>
        {foot ? <div className="shell-foot">{foot}</div> : null}
      </aside>
      <main className="shell-main">{children}</main>
      {overlay}
    </div>
  );
}

/**
 * A labeled group of NavItems inside PageShell's nav. Each item navigates to a
 * genuinely different screen, so this uses plain nav/button semantics with
 * aria-current — not a WAI-ARIA tab widget (which would require roving-tabindex
 * arrow-key navigation to be a correct implementation, not just the tab/tablist
 * roles). Native Tab/Enter/Space already fully covers keyboard use here.
 */
export function NavGroup({ label, children }) {
  return (
    <div className="shell-nav-group">
      {label ? <div className="shell-nav-group-label">{label}</div> : null}
      {children}
    </div>
  );
}

/** One entry in a PageShell nav — an icon, a label, an optional live/plain count badge. */
export function NavItem({ icon: Icon, label, active, live, count, ...props }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      data-live={live ? "true" : undefined}
      className="shell-nav-item"
      {...props}
    >
      {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      <span>{label}</span>
      {count != null ? <span className="count">{count}</span> : null}
    </button>
  );
}
