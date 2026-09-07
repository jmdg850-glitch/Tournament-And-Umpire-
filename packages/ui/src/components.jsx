import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";

export function Button({
  children,
  variant = "primary",
  className = "",
  type = "button",
  ...props
}) {
  const extra = variant === "primary" ? "" : variant;
  return (
    <button type={type} className={`btn ${extra} ${className}`.trim()} {...props}>
      {children}
    </button>
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
  const tournamentLive = kind === "tournament" && status === "in_progress";
  const tone =
    status === "in_progress" && !tournamentLive ? "live"
      : status === "completed" || status === "bye" ? "ok"
      : status === "postponed" || status === "assigned" || status === "ready" || tournamentLive ? "warn"
      : "muted";
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
        <div className="pts">{scoreA}</div>
      </div>
      <div>{center}</div>
      <div>
        <div className="who" title={nameB}>{nameB}</div>
        <div className="pts">{scoreB}</div>
      </div>
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

/** Leaderboard-style table for standings. `rows` need: rank, name, plus any of team/wins/losses/pointDiff/winPct/extra. */
export function StandingsTable({ rows, extraColumns = [] }) {
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
        { key: "name", header: hasTeam ? "Pair / Player" : "Player" },
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

export function Skeleton({ lines = 3 }) {
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
  useEffect(() => {
    const prev = document.activeElement;
    const node = ref.current?.querySelector("button, input, select, textarea, [tabindex]:not([tabindex='-1'])");
    node?.focus();
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
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
        <Button variant={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
          {busy ? "Working…" : confirmLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </Modal>
  );
}

export function Dropdown({ label, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dropdown" style={{ position: "relative" }}>
      <Button variant="secondary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}
      </Button>
      {open ? (
        <div className="panel" style={{ position: "absolute", right: 0, top: "110%", zIndex: 20, minWidth: 180 }}>
          <div onClick={() => setOpen(false)}>{children}</div>
        </div>
      ) : null}
    </div>
  );
}

const ToastCtx = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, tone = "ok") => {
    const id = crypto.randomUUID();
    setToasts((list) => [...list, { id, message, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`.trim()}>{t.message}</div>
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
