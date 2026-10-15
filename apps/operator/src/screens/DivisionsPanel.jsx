import { useId, useState } from "react";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Input, Select, SectionHeader } from "@tournament/ui";
import { Trash2 } from "lucide-react";
import { MIN_GAME_TIME_SEC, MAX_GAME_TIME_SEC, SCORING_TARGET_MIN, SCORING_TARGET_MAX, normalizeScoringTargets } from "@tournament/engine";
import { FORMAT_LABEL } from "../lib.js";

// Race-to target per stage (config.scoringTargets), enforced by the engine/API
// for each match by its stage. Bronze follows the final. Defaults 11 / 15 / 15.
const SCORING_STAGES = [
  ["qualification", "Qualification"],
  ["semifinal", "Semifinal"],
  ["final", "Final"],
];

function targetStrings(config) {
  const t = normalizeScoringTargets(config?.scoringTargets);
  return { qualification: String(t.qualification), semifinal: String(t.semifinal), final: String(t.final) };
}

function isValidTargetText(text) {
  const n = Number(text);
  return /^\d+$/.test(text) && n >= SCORING_TARGET_MIN && n <= SCORING_TARGET_MAX;
}

// { qualification, semifinal, final } as numbers, or null if any is invalid.
function targetsForSave(values) {
  if (!SCORING_STAGES.every(([key]) => isValidTargetText(values[key]))) return null;
  return Object.fromEntries(SCORING_STAGES.map(([key]) => [key, Number(values[key])]));
}

function ScoringRules({ values, onChange }) {
  const baseId = useId();
  const invalid = SCORING_STAGES.filter(([key]) => !isValidTargetText(values[key]));
  const q = Number(values.qualification);
  const p = Number(values.final);
  return (
    <section className="division-section" aria-label="Scoring">
      <h4 className="division-section-title">Scoring</h4>
      <ul className="division-rules">
        {SCORING_STAGES.map(([key, label]) => (
          <li key={key}>
            <label htmlFor={`${baseId}-${key}`}><span>{key === "final" ? "Final / bronze" : label}</span></label>
            <strong className="division-target">
              Race to{" "}
              <input
                id={`${baseId}-${key}`}
                inputMode="numeric"
                value={values[key]}
                aria-invalid={isValidTargetText(values[key]) ? undefined : "true"}
                onChange={(e) => onChange({ [key]: e.target.value.replace(/[^0-9]/g, "").slice(0, 2) })}
              />
            </strong>
          </li>
        ))}
      </ul>
      {invalid.length > 0 ? (
        <p className="field-error" role="alert">Enter a whole number from {SCORING_TARGET_MIN} to {SCORING_TARGET_MAX} for {invalid.map(([, label]) => label).join(", ")}.</p>
      ) : (
        <p className="division-note">
          First side to reach the target wins — no deuce ({q}–{q - 1} and {p}–{p - 1} are final scores). Changes apply to matches that haven't started yet; a started match keeps its target.
        </p>
      )}
    </section>
  );
}

function DivisionScoring({ division, busy, run }) {
  const saved = targetStrings(division.config);
  const [values, setValues] = useState(saved);
  const toSave = targetsForSave(values);
  const unchanged = SCORING_STAGES.every(([key]) => values[key] === saved[key]);
  return (
    <form className="division-form" onSubmit={(e) => {
      e.preventDefault();
      if (!toSave) return;
      run("Save scoring", "update_division", { division_id: division.id, config: { scoringTargets: toSave } });
    }}>
      <ScoringRules values={values} onChange={(patch) => setValues((prev) => ({ ...prev, ...patch }))} />
      <div className="division-actions">
        <Button type="submit" variant="secondary" disabled={!!busy || !toSave || unchanged}>Save scoring</Button>
      </div>
    </form>
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

// Optional default game time for the division's matches (config.gameTimeSeconds).
// Applied when a match with no game time of its own is started; a per-match
// setting (Matches → More → Game timer) takes precedence. Empty = no timer.
function GameTimeDefault({ division, busy, run }) {
  const saved = Number.isInteger(division.config?.gameTimeSeconds) ? String(division.config.gameTimeSeconds / 60) : "";
  const [minutes, setMinutes] = useState(saved);
  const text = minutes.trim();
  const n = Number(text);
  const valid = text === "" || (/^\d+$/.test(text) && n >= MIN_GAME_TIME_SEC / 60 && n <= MAX_GAME_TIME_SEC / 60);
  return (
    <form className="division-section" aria-label="Game timer" onSubmit={(e) => {
      e.preventDefault();
      if (!valid) return;
      run("Save game time", "update_division", {
        division_id: division.id,
        config: { gameTimeSeconds: text === "" ? null : n * 60 },
      });
    }}>
      <h4 className="division-section-title">Game timer</h4>
      <div className="division-grid">
        <Input
          label="Default game time (minutes)"
          inputMode="numeric"
          value={minutes}
          placeholder="No timer"
          onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          error={valid ? undefined : `Enter whole minutes from ${MIN_GAME_TIME_SEC / 60} to ${MAX_GAME_TIME_SEC / 60}, or leave empty.`}
          hint="Counts down from when each match starts. Display only — it never ends a match or changes the score."
        />
      </div>
      <div className="division-actions">
        <Button type="submit" variant="secondary" disabled={!!busy || !valid || text === saved}>Save game time</Button>
      </div>
    </form>
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
  const [newTargets, setNewTargets] = useState(() => targetStrings(null));
  const newTargetsForSave = targetsForSave(newTargets);
  const [confirmDelete, setConfirmDelete] = useState(null);
  return (
    <div className="stack">
      <SectionHeader title="Divisions" description="Group players into competitions, then generate each division's bracket." />
      <Card as="form" className="division-card" onSubmit={(e) => {
        e.preventDefault();
        if (format === "team_elimination" && qualifierCountForSave(draft) == null) return;
        if (!newTargetsForSave) return;
        const config = { bestOf: 1, winBy: "none", isDoubles: true, bronzeMatch: true, scoringTargets: newTargetsForSave };
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
        <ScoringRules values={newTargets} onChange={(patch) => setNewTargets((prev) => ({ ...prev, ...patch }))} />
        {format === "team_elimination" && (
          <QualificationFields cfg={draft} onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))} />
        )}
        <div className="division-actions">
          <Button type="submit" disabled={!!busy || !newTargetsForSave || (format === "team_elimination" && qualifierCountForSave(draft) == null)}>Add division</Button>
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
            <DivisionScoring division={d} busy={busy} run={run} />
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
            <GameTimeDefault division={d} busy={busy} run={run} />
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
