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

// Team elimination always qualifies per team: qualifierCount = pairs taken
// from EACH team (the server enforces this too). Direct Semifinals needs
// teams × per-team = 4, which the server checks with the real team count.
const DEFAULT_QUALIFIERS_PER_TEAM = 2;

// Strict: only a positive whole number (typed as digits) is valid — never
// coerced, so "1.5", "0", "-1", "", "abc" stay invalid instead of turning into
// another number. The server applies the same rule.
function qualifierCountForSave(cfg) {
  const text = String(cfg.qualifierCount ?? "").trim();
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
}

const QUALIFIER_COUNT_ERROR = "Enter a whole number of 1 or more.";

function QualificationFields({ cfg, onChange }) {
  const direct = cfg.progressionMode === "direct_semifinals";
  const perTeam = qualifierCountForSave(cfg);
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
          <Input
            label="Qualifiers per team"
            type="number"
            min={1}
            step={1}
            value={cfg.qualifierCount}
            onChange={(e) => onChange({ qualifierCount: e.target.value })}
            inputMode="numeric"
            required
            error={perTeam == null ? QUALIFIER_COUNT_ERROR : undefined}
            hint={direct
              ? "Teams × qualifiers per team must equal 4 for Direct Semifinals (2 teams → 2 each)."
              : "Pairs taken from EACH team, ranked by wins, then +/-, then points for."}
          />
        </div>
        {perTeam != null && (
          <p className="division-note">
            Qualification: Top {perTeam} {perTeam === 1 ? "pair" : "pairs"} per team — picked automatically when the round robin is complete.
          </p>
        )}
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
    qualifierMode: "top_x_per_team",
    qualifierCount: String(DEFAULT_QUALIFIERS_PER_TEAM),
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
        if (format === "team_elimination" && qualifierCountForSave(draft) == null) return;
        const config = { bestOf: 1, winBy: "none", isDoubles: true, bronzeMatch: true };
        if (format === "team_elimination") {
          config.qualifierMode = "top_x_per_team";
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
          <Button type="submit" disabled={!!busy || (format === "team_elimination" && qualifierCountForSave(draft) == null)}>Add division</Button>
        </div>
      </Card>
      {data.divisions.length === 0 && (
        <EmptyState title="No divisions yet">Add a division to register players and generate a bracket.</EmptyState>
      )}
      {data.divisions.map((d) => {
        const cfg = edit[d.id] || {
          qualifierMode: "top_x_per_team",
          qualifierCount: String(d.config?.qualifierCount ?? DEFAULT_QUALIFIERS_PER_TEAM),
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
                if (qualifierCountForSave(cfg) == null) return;
                run("Update division", "update_division", {
                  division_id: d.id,
                  config: {
                    qualifierMode: "top_x_per_team",
                    qualifierCount: qualifierCountForSave(cfg),
                    sameTeamPolicy: cfg.sameTeamPolicy,
                    progressionMode: cfg.progressionMode,
                  },
                });
              }}>
                {d.config?.qualifierMode !== "top_x_per_team" && (
                  <p className="division-note" role="status">
                    This division was saved with a retired qualification setting. Check Qualifiers per team and press Save options before playoffs can be generated.
                  </p>
                )}
                <QualificationFields cfg={cfg} onChange={(patch) => setEdit((prev) => ({ ...prev, [d.id]: { ...cfg, ...patch } }))} />
                <div className="division-actions">
                  <Button type="submit" variant="secondary" disabled={!!busy || qualifierCountForSave(cfg) == null}>Save options</Button>
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
