import { useState } from "react";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Input, Select, SectionHeader } from "@tournament/ui";
import { Trash2 } from "lucide-react";
import { FORMAT_LABEL } from "../lib.js";

export function DivisionsPanel({ data, busy, run }) {
  const [name, setName] = useState("");
  const [format, setFormat] = useState("single_elim");
  const [winTo, setWinTo] = useState("11");
  const [qualifierMode, setQualifierMode] = useState("top_x");
  const [qualifierCount, setQualifierCount] = useState("4");
  const [sameTeamPolicy, setSameTeamPolicy] = useState("avoid_semis");
  const [progressionMode, setProgressionMode] = useState("playoffs");
  const [edit, setEdit] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(null);
  return (
    <div className="stack">
      <SectionHeader title="Divisions" description="Group players into competitions, then generate each division's bracket." />
      <Card as="form" className="stack" onSubmit={(e) => {
        e.preventDefault();
        const config = { winTo: Number(winTo) || 11, bestOf: 1, winBy: "none", isDoubles: true, bronzeMatch: true };
        if (format === "team_elimination") {
          config.qualifierMode = qualifierMode;
          config.qualifierCount = progressionMode === "direct_semifinals" ? 4 : Number(qualifierCount) || 4;
          config.sameTeamPolicy = sameTeamPolicy;
          config.progressionMode = progressionMode;
        }
        run("Create division", "create_division", {
          tournament_id: data.tournament.id,
          name,
          format,
          config,
        });
        setName("");
      }}>
        <div className="row">
          <Input label="Division name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Select label="Format" value={format} onChange={(e) => setFormat(e.target.value)} hint="Single players/pairs knocked out each round, or teams of pairs competing as a group.">
            <option value="single_elim">Single elimination</option>
            <option value="team_elimination">Team elimination</option>
          </Select>
          <Button type="submit" disabled={!!busy}>Add division</Button>
        </div>
        <div className="row">
          <Select label="Game target" value={winTo} onChange={(e) => setWinTo(e.target.value)} hint="This match ends as soon as a team reaches this number.">
            <option value="11">Race to 11</option>
            <option value="15">Race to 15</option>
          </Select>
        </div>
        {format === "team_elimination" && (
          <div className="row">
            <Select
              label="After Qualifiers"
              value={progressionMode}
              onChange={(e) => setProgressionMode(e.target.value)}
              hint={
                progressionMode === "direct_semifinals"
                  ? "The highest-ranked qualifiers advance directly to the semifinals."
                  : "Qualified competitors go through the playoff bracket before the semifinals."
              }
            >
              <option value="playoffs">Playoffs / Elimination</option>
              <option value="direct_semifinals">Direct Semifinals</option>
            </Select>
            <Select label="Qualification" value={qualifierMode} onChange={(e) => setQualifierMode(e.target.value)}>
              <option value="top_x">Top X overall</option>
              <option value="top_x_per_team">Top X per team</option>
              <option value="manual">Manual qualification</option>
            </Select>
            <Input
              label="Qualifier count"
              value={progressionMode === "direct_semifinals" ? "4" : qualifierCount}
              onChange={(e) => setQualifierCount(e.target.value)}
              inputMode="numeric"
              disabled={progressionMode === "direct_semifinals"}
              hint={progressionMode === "direct_semifinals" ? "Fixed at 4 for Direct Semifinals." : undefined}
            />
            <Select
              label="Same-team matchup policy"
              value={sameTeamPolicy}
              onChange={(e) => setSameTeamPolicy(e.target.value)}
              hint="Keeps pairs from the same team apart in the bracket for as long as possible, so teammates don't face each other early."
            >
              <option value="allow_anywhere">Allow anywhere — no restriction</option>
              <option value="avoid_quarterfinals">Avoid until the quarterfinals</option>
              <option value="avoid_semis">Avoid until the semifinals</option>
              <option value="avoid_until_final">Avoid until the final</option>
            </Select>
          </div>
        )}
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
          winTo: String(d.config?.winTo ?? 11),
        };
        return (
          <Card className="stack" key={d.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <h3 style={{ margin: 0 }}>{d.name}</h3>
                  <Badge tone="info">{FORMAT_LABEL[d.format] || d.format}</Badge>
                </div>
              </div>
              <div className="row">
                {d.format === "team_elimination" ? (
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
            <form className="row" onSubmit={(e) => {
              e.preventDefault();
              run("Update division", "update_division", {
                division_id: d.id,
                config: {
                  winTo: Number(cfg.winTo) || 11,
                  winBy: "none",
                },
              });
            }}>
              <Select
                label="Game target"
                value={cfg.winTo}
                onChange={(e) => setEdit((prev) => ({ ...prev, [d.id]: { ...cfg, winTo: e.target.value } }))}
                hint="This match ends as soon as a team reaches this number. Applies to newly started matches — this is the default an operator/umpire is shown when starting a match, and can still be confirmed or changed per match."
              >
                <option value="11">Race to 11</option>
                <option value="15">Race to 15</option>
              </Select>
              <Button type="submit" variant="secondary" disabled={!!busy}>Save scoring</Button>
            </form>
            {d.format === "team_elimination" && (
              <form className="row" onSubmit={(e) => {
                e.preventDefault();
                run("Update division", "update_division", {
                  division_id: d.id,
                  config: {
                    qualifierMode: cfg.qualifierMode,
                    qualifierCount: cfg.progressionMode === "direct_semifinals" ? 4 : Number(cfg.qualifierCount) || 4,
                    sameTeamPolicy: cfg.sameTeamPolicy,
                    progressionMode: cfg.progressionMode,
                  },
                });
              }}>
                <Select
                  label="After Qualifiers"
                  value={cfg.progressionMode}
                  onChange={(e) => setEdit((prev) => ({ ...prev, [d.id]: { ...cfg, progressionMode: e.target.value } }))}
                  hint={
                    cfg.progressionMode === "direct_semifinals"
                      ? "The highest-ranked qualifiers advance directly to the semifinals."
                      : "Qualified competitors go through the playoff bracket before the semifinals."
                  }
                >
                  <option value="playoffs">Playoffs / Elimination</option>
                  <option value="direct_semifinals">Direct Semifinals</option>
                </Select>
                <Select
                  label="Qualification"
                  value={cfg.qualifierMode}
                  onChange={(e) => setEdit((prev) => ({ ...prev, [d.id]: { ...cfg, qualifierMode: e.target.value } }))}
                >
                  <option value="top_x">Top X overall</option>
                  <option value="top_x_per_team">Top X per team</option>
                  <option value="manual">Manual qualification</option>
                </Select>
                <Input
                  label="Qualifier count"
                  value={cfg.progressionMode === "direct_semifinals" ? "4" : cfg.qualifierCount}
                  onChange={(e) => setEdit((prev) => ({ ...prev, [d.id]: { ...cfg, qualifierCount: e.target.value } }))}
                  inputMode="numeric"
                  disabled={cfg.progressionMode === "direct_semifinals"}
                  hint={cfg.progressionMode === "direct_semifinals" ? "Fixed at 4 for Direct Semifinals." : undefined}
                />
                <Select
                  label="Same-team matchup policy"
                  value={cfg.sameTeamPolicy}
                  onChange={(e) => setEdit((prev) => ({ ...prev, [d.id]: { ...cfg, sameTeamPolicy: e.target.value } }))}
                  hint="Keeps pairs from the same team apart in the bracket for as long as possible."
                >
                  <option value="allow_anywhere">Allow anywhere — no restriction</option>
                  <option value="avoid_quarterfinals">Avoid until the quarterfinals</option>
                  <option value="avoid_semis">Avoid until the semifinals</option>
                  <option value="avoid_until_final">Avoid until the final</option>
                </Select>
                <Button type="submit" variant="secondary" disabled={!!busy}>Save options</Button>
              </form>
            )}
            <div className="row" style={{ justifyContent: "flex-end", borderTop: "1px solid var(--border)", paddingTop: "var(--space-3)" }}>
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
