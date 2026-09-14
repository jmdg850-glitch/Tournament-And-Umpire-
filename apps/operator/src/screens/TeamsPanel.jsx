import { useState } from "react";
import { Button, Card, EmptyState, Input, Modal, SectionHeader, Select, Table } from "@tournament/ui";
import { assignedPersonIdsInDivision } from "../lib.js";

function TeamRosterModal({ team, data, busy, run, onClose }) {
  const [personId, setPersonId] = useState("");
  const [search, setSearch] = useState("");
  const members = data.teamMembers || [];
  const roster = members.filter((m) => m.team_id === team.id);
  const q = search.toLowerCase();
  const assigned = assignedPersonIdsInDivision(data, team.division_id, {
    exceptTeamId: team.id,
    exceptParticipantTeamId: team.id,
  });
  const onThisTeam = new Set(roster.map((m) => m.person_id));
  const options = data.persons.filter((p) => {
    if (onThisTeam.has(p.id)) return false;
    if (assigned.has(p.id)) return false;
    if (q && !p.display_name.toLowerCase().includes(q)) return false;
    return true;
  });
  const selected = personId || options[0]?.id || "";
  return (
    <Modal title={team.name} onClose={onClose}>
      <div className="stack">
        {roster.length === 0 ? (
          <EmptyState title="No members yet">Search a player below and add them to this team.</EmptyState>
        ) : (
          <Table
            columns={[
              { key: "name", header: "Player", render: (m) => data.persons.find((p) => p.id === m.person_id)?.display_name || m.person_id },
              {
                key: "remove",
                header: "",
                render: (m) => (
                  <Button variant="danger" disabled={!!busy} onClick={() => run("Remove member", "remove_team_member", { team_member_id: m.id }, true)}>
                    Remove
                  </Button>
                ),
              },
            ]}
            rows={roster}
          />
        )}
        <form className="row" onSubmit={(e) => {
          e.preventDefault();
          if (!selected) return;
          run("Add member", "add_team_member", { team_id: team.id, person_id: selected });
        }}>
          <Input label="Search player" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select label="Player" hideLabel value={selected} onChange={(e) => setPersonId(e.target.value)}>
            {options.length === 0 && <option value="">No matching players</option>}
            {options.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
          </Select>
          <Button type="submit" disabled={!!busy || !options.length}>Add member</Button>
        </form>
      </div>
    </Modal>
  );
}

export function TeamsPanel({ data, busy, run }) {
  const [name, setName] = useState("");
  const [divisionId, setDivisionId] = useState(data.divisions[0]?.id || "");
  const [openTeamId, setOpenTeamId] = useState(null);
  const members = data.teamMembers || [];
  const openTeam = data.teams.find((t) => t.id === openTeamId) || null;

  return (
    <div className="stack">
      <SectionHeader title="Teams" description="Group registered players into a team roster for team elimination divisions." />
      <Card as="form" className="row" onSubmit={(e) => {
        e.preventDefault();
        run("Create team", "create_team", { tournament_id: data.tournament.id, name, division_id: divisionId || null });
        setName("");
      }}>
        <Input label="Team name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Select label="Division" value={divisionId} onChange={(e) => setDivisionId(e.target.value)}>
          {data.divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
        <Button type="submit" disabled={!!busy}>Add team</Button>
      </Card>
      {data.teams.length === 0 ? (
        <EmptyState title="No teams yet">Needed for team elimination — create a team, then add players to its roster.</EmptyState>
      ) : (
        <Table
          responsive
          columns={[
            { key: "name", header: "Team" },
            { key: "division", header: "Division", render: (t) => data.divisions.find((d) => d.id === t.division_id)?.name || "—" },
            {
              key: "members",
              header: "Roster",
              render: (t) => {
                const n = members.filter((m) => m.team_id === t.id).length;
                return n === 0 ? <span className="muted">Empty</span> : `${n} member${n === 1 ? "" : "s"}`;
              },
            },
            {
              key: "manage",
              header: "",
              render: (t) => <Button variant="secondary" onClick={() => setOpenTeamId(t.id)}>Manage roster</Button>,
            },
          ]}
          rows={data.teams}
        />
      )}
      {openTeam && (
        <TeamRosterModal team={openTeam} data={data} busy={busy} run={run} onClose={() => setOpenTeamId(null)} />
      )}
    </div>
  );
}
