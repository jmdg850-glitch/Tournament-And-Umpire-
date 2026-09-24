import { useState } from "react";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Input, Select, SectionHeader } from "@tournament/ui";
import { Trash2 } from "lucide-react";
import { QUALIFICATION_TARGET, PLAYOFF_TARGET } from "@tournament/engine";
import { FORMAT_LABEL } from "../lib.js";

// Scoring is decided by the match's stage and enforced by the engine/API —
// it is shown here for reference only and is not a per-division choice.
function ScoringRules() {
  return (
    <section className="division-section" aria-label="Scoring">
      <h4 className="division-section-title">Scoring</h4>
      <ul className="division-rules">
        <li><span>Qualification</span><strong>Race to {QUALIFICATION_TARGET}</strong></li>
        <li><span>Semifinal</span><strong>Race to {PLAYOFF_TARGET}</strong></li>
        <li><span>Final</span><strong>Race to {PLAYOFF_TARGET}</strong></li>
      </ul>
      <p className="division-note">Set automatically by stage. First side to reach the target wins — no deuce ({QUALIFICATION_TARGET}–{QUALIFICATION_TARGET - 1} and {PLAYOFF_TARGET}–{PLAYOFF_TARGET - 1} are final scores).</p>
    </section>
  );
}

// Direct Semifinals always seeds exactly 4 pairs. With "Top X per team" the
// count is per team (teams × per-team must equal 4, checked by the server);
// with "Top X overall" it is fixed at 4.
function qualifierCountForSave(cfg) {
  const lockedToFour = cfg.progressionMode === "direct_semifinals" && cfg.qualifierMode !== "top_x_per_team";
  return lockedToFour ? 4 : Number(cfg.qualifierCount) || 4;
}

function QualificationFields({ cfg, onChange }) {
  const direct = cfg.progressionMode === "direct_semifinals";
  const perTeam = cfg.qualifierMode === "top_x_per_team";
  const locked = direct && !perTeam;
  return (
    <>
      <section className="division-section" aria-label="Qualification">
        <h4 className="division-section-title">Qualification</h4>
        <div className="division-grid">
          <Select
            label="After Qualifiers"
            value={cfg.progressionMode}
            onChange={(e) => onChange({ progressionMode: e.target.value })}
            hint={direct
              ? "The highest-ranked qualifiers advance directly to the semifinals."
              : "Qualified competitors go through the playoff bracket before the semifinals."}
          >
            <option value="playoffs">Playoffs / Elimination</option>
            <option value="direct_semifinals">Direct Semifinals</option>
          </Select>
          <Select label="Qualification method" value={cfg.qualifierMode} onChange={(e) => onChange({ qualifierMode: e.target.value })}>
            <option value="top_x">Top X overall</option>
            <option value="top_x_per_team">Top X per team</option>
            <option value="manual">Manual qualification</option>
          </Select>
          <Input
            label={perTeam ? "Qualifiers per team" : "Qualifier count"}
            value={locked ? "4" : cfg.qualifierCount}
            onChange={(e) => onChange({ qualifierCount: e.target.value })}
            inputMode="numeric"
            disabled={locked}
            hint={locked
              ? "Fixed at 4 for Direct Semifinals."
              : direct
                ? "Teams × qualifiers per team must equal 4 for Direct Semifinals (2 teams → 2 each)."
                : undefined}
          />
        </div>
      </section>
      <section className="division-section" aria-label="Bracket">
        <h4 className="division-section-title">Bracket</h4>
        <div className="division-grid">
          <Select
            label="Same-team matchup policy"
            value={cfg.sameTeamPolicy}
            onChange={(e) => onChange({ sameTeamPolicy: e.target.value })}
            hint="Keeps pairs from the same team apart in the bracket for as long as possible, so teammates don't face each other early."
          >
            <option value="allow_anywhere">Allow anywhere — no restriction</option>
            <option value="avoid_quarterfinals">Avoid until the quarterfinals</option>
            <option value="avoid_semis">Avoid until the semifinals</option>
            <option value="avoid_until_final">Avoid until the final</option>
          </Select>
        </div>
      </section>
    </>
  );
}

export function DivisionsPanel({ data, busy, run }) {
  const [name, setName] = useState("");
  const [format, setFormat] = useState("single_elim");
  const [draft, setDraft] = useState({
    qualifierMode: "top_x",
    qualifierCount: "4",
    sameTeamPolicy: "avoid_semis",
    progressionMode: "playoffs",
  });
  const [edit, setEdit] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(null);
  return (
    <div className="stack">
      <SectionHeader title="Divisions" description="Group players into competitions, then generate each division's bracket." />
      <Card as="form" className="division-card" onSubmit={(e) => {
        e.preventDefault();
        const config = { bestOf: 1, winBy: "none", isDoubles: true, bronzeMatch: true };
        if (format === "team_elimination") {
          config.qualifierMode = draft.qualifierMode;
          config.qualifierCount = qualifierCountForSave(draft);
          config.sameTeamPolicy = draft.sameTeamPolicy;
          config.progressionMode = draft.progressionMode;
        }
        run("Create division", "create_division", {
          tournament_id: data.tournament.id,
          name,
          format,
          config,
        });
        setName("");
      }}>
        <h3 className="division-title">New division</h3>
        <section className="division-section" aria-label="Division">
          <div className="division-grid">
            <Input label="Division name" value={name} onChange={(e) => setName(e.target.value)} required />
            <Select label="Format" value={format} onChange={(e) => setFormat(e.target.value)} hint="Single players/pairs knocked out each round, or teams of pairs competing as a group.">
              <option value="single_elim">Single elimination</option>
              <option value="team_elimination">Team elimination</option>
            </Select>
          </div>
        </section>
        <ScoringRules />
        {format === "team_elimination" && (
          <QualificationFields cfg={draft} onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))} />
        )}
        <div className="division-actions">
          <Button type="submit" disabled={!!busy}>Add division</Button>
        </div>
      </Card>
      {data.divisions.length === 0 && (
        <EmptyState title="No divisions yet">Add a division to register players and generate a bracket.</EmptyState>
      )}
      {data.divisions.map((d) => {
        const cfg = edit[d.id] || {
          qualifierMode: d.config?.qualifierMode || "top_x",
          qualifierCount: String(d.config?.qualifierCount ?? 4),
          sameTeamPolicy: d.config?.sameTeamPolicy || "avoid_semis",
          progressionMode: d.config?.progressionMode || "playoffs",
        };
        const isTeam = d.format === "team_elimination";
        return (
          <Card className="division-card" key={d.id}>
            <div className="division-head">
              <div className="division-head-title">
                <h3 className="division-title">{d.name}</h3>
                <Badge tone="info">{FORMAT_LABEL[d.format] || d.format}</Badge>
              </div>
              <div className="division-head-actions">
                {isTeam ? (
                  <>
                    <Button disabled={!!busy} onClick={() => run("Generate qualification", "generate_team_elimination", { division_id: d.id }, true)}>
                      Generate qualification
                    </Button>
                    <Button variant="secondary" disabled={!!busy} onClick={() => run("Generate playoffs", "generate_team_playoffs", { division_id: d.id }, true)}>
                      Generate playoffs
                    </Button>
                  </>
                ) : (
                  <Button disabled={!!busy} onClick={() => run("Generate bracket", "generate_bracket", { division_id: d.id }, true)}>
                    Generate bracket
                  </Button>
                )}
              </div>
            </div>
            <ScoringRules />
            {isTeam && (
              <form className="division-form" onSubmit={(e) => {
                e.preventDefault();
                run("Update division", "update_division", {
                  division_id: d.id,
                  config: {
                    qualifierMode: cfg.qualifierMode,
                    qualifierCount: qualifierCountForSave(cfg),
                    sameTeamPolicy: cfg.sameTeamPolicy,
                    progressionMode: cfg.progressionMode,
                  },
                });
              }}>
                <QualificationFields cfg={cfg} onChange={(patch) => setEdit((prev) => ({ ...prev, [d.id]: { ...cfg, ...patch } }))} />
                <div className="division-actions">
                  <Button type="submit" variant="secondary" disabled={!!busy}>Save options</Button>
                </div>
              </form>
            )}
            <div className="division-danger">
              <span className="division-note">Permanently removes this division and its matches.</span>
              <Button
                type="button"
                variant="danger"
                className="compact"
                disabled={!!busy}
                aria-label={`Delete ${d.name} division`}
                onClick={() => setConfirmDelete(d)}
              >
                <Trash2 size={14} aria-hidden="true" /> Delete division
              </Button>
            </div>
          </Card>
        );
      })}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete "${confirmDelete.name}"?`}
          body={`This permanently deletes the division and everything scheduled under it — its matches, bracket progress, and team/player registrations for this division — and removes it from every operational view, including the Dashboard's Attention Needed. Other divisions in this tournament aren't affected. This can't be undone.`}
          confirmLabel="Delete division"
          danger
          busy={!!busy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const target = confirmDelete;
            setConfirmDelete(null);
            run("Delete division", "delete_division", { division_id: target.id });
          }}
        />
      )}
    </div>
  );
}
