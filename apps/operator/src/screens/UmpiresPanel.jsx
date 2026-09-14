import { useState } from "react";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Input, SectionHeader, Stat } from "@tournament/ui";
import { courtFor, memberName, sideOf } from "../lib.js";

const UUID_LOOKS_VALID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function UmpiresPanel({ data, session, busy, run }) {
  // Anyone who already shares a tournament with this organizer is visible to them
  // (that's how RLS on `profiles` works today) — so returning organizers can search
  // their existing umpire pool by name with zero backend changes. A brand-new umpire
  // who has never shared a tournament with this organizer won't appear here yet;
  // that cold-start case still needs the manual ID handoff below.
  const existingMemberIds = new Set(data.members.map((m) => m.user_id));
  const searchablePool = (data.profiles || []).filter((p) => p.id !== session.user.id && !existingMemberIds.has(p.id));

  const [mode, setMode] = useState(searchablePool.length ? "search" : "manual");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [userId, setUserId] = useState("");
  const [idError, setIdError] = useState("");
  const [copied, setCopied] = useState(false);
  const [pendingManualId, setPendingManualId] = useState(null);

  const matches = searchablePool.filter((p) => !query.trim() || p.display_name.toLowerCase().includes(query.trim().toLowerCase()));

  async function copyMyId() {
    try {
      await navigator.clipboard.writeText(session.user.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy your account ID", session.user.id);
    }
  }

  function assign(id) {
    run("Assign umpire", "add_member", { tournament_id: data.tournament.id, user_id: id, role: "umpire" });
  }

  return (
    <div className="stack">
      <SectionHeader title="Umpires" description="Assign umpires to matches and see who's currently live, assigned, or available." />
      <Card className="stack">
        <h2>Assign umpire</h2>
        {mode === "search" ? (
          <>
            <p className="muted" style={{ marginTop: -6 }}>Search people you've already worked with in other tournaments.</p>
            <Input label="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Start typing a name…" />
            {matches.length === 0 && query.trim() && (
              <p className="muted">No match for "{query.trim()}".</p>
            )}
            {matches.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                {matches.slice(0, 8).map((p) => (
                  <div key={p.id} className="row" style={{ justifyContent: "space-between" }}>
                    <span>{p.display_name}</span>
                    <Button type="button" variant="secondary" disabled={!!busy} onClick={() => assign(p.id)}>Assign</Button>
                  </div>
                ))}
              </div>
            )}
            <Button type="button" variant="ghost" className="compact" onClick={() => setMode("manual")}>Can't find this umpire?</Button>
          </>
        ) : (
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const id = userId.trim();
            if (!UUID_LOOKS_VALID.test(id)) {
              setIdError("That doesn't look like a valid account ID — it should look like 8-4-4-4-12 characters (e.g. a1b2c3d4-....).");
              return;
            }
            setIdError("");
            setPendingManualId(id);
          }}>
            <Alert tone="warn">
              Advanced — only use this if the umpire doesn't appear in search above. For a new umpire who hasn't worked with you before: ask them to sign in once, then share their account ID with you.
            </Alert>
            <Input
              label="Advanced: enter umpire ID"
              value={userId}
              onChange={(e) => { setUserId(e.target.value); setIdError(""); }}
              error={idError}
              hint={!idError ? "Looks like: a1b2c3d4-e5f6-7890-ab12-cd34ef567890" : undefined}
              required
            />
            <Button type="submit" variant="secondary" disabled={!!busy}>Assign umpire</Button>
            <div className="row" style={{ marginTop: 4 }}>
              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>Your own account ID: {session.user.id}</span>
              <Button type="button" variant="ghost" className="compact" onClick={copyMyId}>{copied ? "Copied" : "Copy"}</Button>
            </div>
            {searchablePool.length > 0 && (
              <Button type="button" variant="ghost" className="compact" onClick={() => setMode("search")}>Search existing people instead</Button>
            )}
          </form>
        )}
      </Card>
      {pendingManualId && (
        <ConfirmDialog
          title="Assign this umpire?"
          body={`This assigns account ID ${pendingManualId} as an umpire on this tournament. Double-check the ID is correct — a typo assigns the wrong person.`}
          confirmLabel="Assign umpire"
          busy={!!busy}
          onCancel={() => setPendingManualId(null)}
          onConfirm={() => {
            assign(pendingManualId);
            setPendingManualId(null);
            setUserId("");
          }}
        />
      )}
      {(() => {
        const staff = data.members.filter((m) => ["umpire", "organizer", "admin"].includes(m.role));
        const withAssignment = staff.map((m) => {
          const asg = data.umpireAssignments.find((a) => a.user_id === m.user_id);
          const match = asg ? data.matches.find((mm) => mm.id === asg.match_id) : null;
          const court = match ? courtFor(match, data) : null;
          return { ...m, match, court, isLive: match?.status === "in_progress" };
        });
        const activeCount = withAssignment.filter((m) => m.isLive).length;
        const assignedCount = withAssignment.filter((m) => m.match && !m.isLive).length;
        const availableCount = withAssignment.length - activeCount - assignedCount;
        return (
          <>
            <div className="grid4">
              <Stat value={withAssignment.length} label="Staff" />
              <Stat tone={activeCount ? "hero live" : "hero"} value={activeCount} label="Currently umpiring" />
              <Stat value={assignedCount} label="Assigned, not live" />
              <Stat tone="quiet" value={availableCount} label="Available" />
            </div>
            <div className="section-label">Staff</div>
            {withAssignment.length === 0 ? (
              <EmptyState title="No staff yet">Assign an umpire above — search your existing pool, or add someone new by their account ID.</EmptyState>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {withAssignment.map((m) => (
                  <Card key={m.id} className="row" style={{ justifyContent: "space-between", padding: "12px 16px" }}>
                    <div>
                      <strong>{memberName(m.user_id, data.profiles)}</strong>
                      <div className="muted" style={{ fontSize: "var(--text-sm)" }}>
                        {m.role}
                        {m.match ? ` · ${sideOf(m.match.id, "A", data).name} vs ${sideOf(m.match.id, "B", data).name}${m.court ? ` · ${m.court.name}` : ""}` : " · Not currently assigned"}
                      </div>
                    </div>
                    {m.isLive ? <Badge tone="live">● LIVE</Badge> : m.match ? <Badge tone="warn">Assigned</Badge> : <Badge tone="muted">Available</Badge>}
                  </Card>
                ))}
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}
