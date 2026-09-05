import { Table, Thead, Tr, Td, RankCell } from "../../components/ui/Table.jsx";
import { D } from "../../theme/tokens.js";

// Team-level standings table for team_elimination — same shape/convention as
// StandingsPanel.jsx (pair-level, other formats), one level up: rows are
// Teams, not pairs. `standings`: output of buildTeamStandingsFromRoundRobin
// (already ranked/tie-broken). `teamGroups`: tournament_teams rows, for name
// lookup.
export function TeamStandingsPanel({standings,teamGroups}){
  const teamName=id=>{ const t=teamGroups.find(x=>x.id===id); return t?t.name:"—"; };
  if(!standings.length) return <div style={{textAlign:"center",padding:"30px 20px",color:D.textMuted,fontSize:13}}>No completed matchups yet.</div>;
  return(
    <div>
      <div style={{fontSize:11,color:D.textMuted,marginBottom:8}}>Team-vs-Team stage information only — Semifinal qualification is decided by individual pair standings, not this table.</div>
      <Table>
        <Thead columns={["#","Team","Played","W","L","Ind. Wins","Ind. Losses"]}/>
        <tbody>
          {standings.map(r=>(
            <Tr key={r.teamId} top={r.rank<=3}>
              <RankCell rank={r.rank}/>
              <Td strong color={D.textPrimary}>{teamName(r.teamId)}</Td>
              <Td align="center">{r.matchesPlayed}</Td>
              <Td align="center" strong color={D.green}>{r.wins}</Td>
              <Td align="center" strong color={D.red}>{r.losses}</Td>
              <Td align="center">{r.pairMatchWins}</Td>
              <Td align="center">{r.pairMatchLosses}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
