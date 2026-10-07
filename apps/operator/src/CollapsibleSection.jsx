import { useCallback, useId, useState } from "react";
import { Button } from "@tournament/ui";
import { ChevronRight } from "lucide-react";

// Presentation-only collapse state for long, per-division screens (Matches
// tab, Brackets tab, Bracket/Match display windows). Only the ids the
// operator has *collapsed* are remembered, per screen + tournament, in this
// computer's localStorage — so everything starts expanded, and a blocked or
// cleared storage simply means "all open". Never affects tournament data.
// null = nothing saved yet for this screen (use its defaults).
function readCollapsed(storageKey) {
  if (!storageKey) return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw == null) return null;
    const ids = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return null;
  }
}

function writeCollapsed(storageKey, set) {
  if (!storageKey) return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...set]));
  } catch {
    // Storage unavailable — the choice just isn't remembered.
  }
}

export function useCollapsedSections(storageKey, defaultCollapsed = []) {
  const [collapsed, setCollapsed] = useState(() => {
    return readCollapsed(storageKey) || new Set(defaultCollapsed);
  });

  const update = useCallback((fn) => {
    setCollapsed((prev) => {
      const next = fn(new Set(prev));
      writeCollapsed(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const isOpen = useCallback((id) => !collapsed.has(id), [collapsed]);
  const toggle = useCallback((id) => update((s) => {
    if (s.has(id)) s.delete(id);
    else s.add(id);
    return s;
  }), [update]);
  const setAll = useCallback((ids, open) => update((s) => {
    for (const id of ids) {
      if (open) s.delete(id);
      else s.add(id);
    }
    return s;
  }), [update]);

  return { isOpen, toggle, setAll };
}

// "Collapse all" while anything is open, otherwise "Expand all". Hidden when
// there's only one section — nothing to navigate between.
export function ExpandCollapseAll({ ids, sections }) {
  if (ids.length < 2) return null;
  const anyOpen = ids.some((id) => sections.isOpen(id));
  return (
    <Button type="button" variant="ghost" className="compact" onClick={() => sections.setAll(ids, !anyOpen)}>
      {anyOpen ? "Collapse all" : "Expand all"}
    </Button>
  );
}

// A section whose header stays visible and toggles its body. `title` and
// `summary` are what the operator still sees when collapsed; `actions` sit
// to the right of (never inside) the toggle button.
export function CollapsibleSection({ title, summary, actions, open, onToggle, className = "", headingLevel = 3, children }) {
  const bodyId = useId();
  const Heading = `h${headingLevel}`;
  return (
    <section className={`collapsible ${className}`.trim()} data-open={open ? "true" : "false"}>
      <div className="collapsible-head">
        <button
          type="button"
          className="collapsible-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <ChevronRight size={16} className="collapsible-chevron" aria-hidden="true" />
          <Heading className="collapsible-title">{title}</Heading>
          {summary ? <span className="collapsible-summary">{summary}</span> : null}
        </button>
        {actions ? <div className="collapsible-actions">{actions}</div> : null}
      </div>
      {open ? <div id={bodyId} className="collapsible-body reveal">{children}</div> : null}
    </section>
  );
}
