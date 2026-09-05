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

export function Select({ label, id, hideLabel, children, ...props }) {
  const autoId = useId();
  const inputId = id || autoId;
  return (
    <label htmlFor={inputId}>
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
      <select id={inputId} {...props}>
        {children}
      </select>
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

export function Table({ columns, rows, empty, rowProps }) {
  if (!rows?.length) return empty || null;
  return (
    <div className="table-wrap">
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
                <td key={c.key}>{c.render ? c.render(row) : row[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
  const push = useCallback((message, tone = "info") => {
    const id = crypto.randomUUID();
    setToasts((list) => [...list, { id, message, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">{t.message}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
